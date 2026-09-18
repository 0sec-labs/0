//! DNS sockets belong to the resolution future. No system getaddrinfo worker or
//! detached resolver driver can survive cancellation of that future.
use crate::{Error, ErrorCode};
use futures_util::future::BoxFuture;
use hickory_proto::{
    op::{Message, MessageType, OpCode, Query, ResponseCode},
    rr::{DNSClass, Name, RData, RecordType},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::{IpAddr, SocketAddr},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
};
use zero_protocol::http::HttpLimits;

pub trait Resolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        limits: &'a HttpLimits,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, Error>>;
}
pub struct OwnedDns {
    server: SocketAddr,
    hosts: BTreeMap<String, Vec<IpAddr>>,
}
impl OwnedDns {
    pub fn new(server: SocketAddr, hosts: BTreeMap<String, Vec<IpAddr>>) -> Result<Self, Error> {
        if server.port() == 0
            || server.ip().is_unspecified()
            || hosts.len() > 4096
            || hosts
                .iter()
                .any(|(h, a)| h.len() > 253 || a.is_empty() || a.len() > 64)
        {
            return Err(ErrorCode::Dns);
        }
        Ok(Self { server, hosts })
    }
    /// Captures bounded Unix resolver configuration. No NSS, search suffixes,
    /// mDNS or implicit blocking resolver fallback is supported.
    #[cfg(unix)]
    pub fn system() -> Result<Self, Error> {
        fn read(path: &str) -> Result<String, Error> {
            let f = std::fs::File::open(path).map_err(|_| ErrorCode::Dns)?;
            let mut bytes = Vec::new();
            f.take(262145)
                .read_to_end(&mut bytes)
                .map_err(|_| ErrorCode::Dns)?;
            if bytes.len() > 262144 {
                return Err(ErrorCode::Dns);
            }
            String::from_utf8(bytes).map_err(|_| ErrorCode::Dns)
        }
        let resolv = read("/etc/resolv.conf")?;
        let server = resolv
            .lines()
            .filter_map(|l| {
                let mut t = l.split('#').next()?.split_whitespace();
                if t.next()? == "nameserver" {
                    t.next()?.parse::<IpAddr>().ok()
                } else {
                    None
                }
            })
            .next()
            .ok_or(ErrorCode::Dns)?;
        let mut hosts: BTreeMap<String, Vec<IpAddr>> = BTreeMap::new();
        for line in read("/etc/hosts")?.lines() {
            let mut fields = line
                .split('#')
                .next()
                .unwrap_or_default()
                .split_whitespace();
            let Some(ip) = fields.next().and_then(|s| s.parse::<IpAddr>().ok()) else {
                continue;
            };
            for name in fields {
                hosts
                    .entry(name.trim_end_matches('.').to_lowercase())
                    .or_default()
                    .push(ip);
            }
        }
        Self::new(SocketAddr::new(server, 53), hosts)
    }
    #[cfg(not(unix))]
    pub fn system() -> Result<Self, Error> {
        Err(ErrorCode::Dns)
    }
    async fn query(
        &self,
        name: &Name,
        kind: RecordType,
        queries: &mut u32,
        max: u32,
    ) -> Result<Message, Error> {
        *queries += 1;
        if *queries > max {
            return Err(ErrorCode::Dns);
        }
        let id = u16::from_be_bytes([
            uuid::Uuid::new_v4().as_bytes()[0],
            uuid::Uuid::new_v4().as_bytes()[1],
        ]);
        let mut request = Message::new();
        request
            .set_id(id)
            .set_recursion_desired(true)
            .add_query(Query::query(name.clone(), kind));
        let bytes = request.to_vec().map_err(|_| ErrorCode::Dns)?;
        let socket = UdpSocket::bind(if self.server.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })
        .await
        .map_err(|_| ErrorCode::Dns)?;
        socket
            .connect(self.server)
            .await
            .map_err(|_| ErrorCode::Dns)?;
        socket.send(&bytes).await.map_err(|_| ErrorCode::Dns)?;
        let mut buffer = vec![0; 65535];
        let n = socket.recv(&mut buffer).await.map_err(|_| ErrorCode::Dns)?;
        buffer.truncate(n);
        let mut response = Message::from_vec(&buffer).map_err(|_| ErrorCode::Dns)?;
        check(&response, id, name, kind)?;
        if response.truncated() {
            *queries += 1;
            if *queries > max {
                return Err(ErrorCode::Dns);
            }
            let mut tcp = TcpStream::connect(self.server)
                .await
                .map_err(|_| ErrorCode::Dns)?;
            tcp.write_u16(bytes.len() as u16)
                .await
                .map_err(|_| ErrorCode::Dns)?;
            tcp.write_all(&bytes).await.map_err(|_| ErrorCode::Dns)?;
            let len = tcp.read_u16().await.map_err(|_| ErrorCode::Dns)? as usize;
            if len < 12 {
                return Err(ErrorCode::Dns);
            }
            buffer.resize(len, 0);
            tcp.read_exact(&mut buffer)
                .await
                .map_err(|_| ErrorCode::Dns)?;
            response = Message::from_vec(&buffer).map_err(|_| ErrorCode::Dns)?;
            check(&response, id, name, kind)?;
            if response.truncated() {
                return Err(ErrorCode::Dns);
            }
        }
        Ok(response)
    }
    async fn addresses(&self, host: &str, limits: &HttpLimits) -> Result<Vec<IpAddr>, Error> {
        if let Ok(ip) = host.parse() {
            return Ok(vec![ip]);
        }
        if host == "localhost" || host.ends_with(".localhost") {
            return Ok(vec![
                IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
            ]);
        }
        if let Some(values) = self.hosts.get(host) {
            if values.len() > limits.max_dns_answers as usize {
                return Err(ErrorCode::Dns);
            }
            return Ok(values.clone());
        }
        let mut queries = 0;
        let mut result = BTreeSet::new();
        for kind in [RecordType::A, RecordType::AAAA] {
            let mut name = Name::from_ascii(format!("{host}.")).map_err(|_| ErrorCode::Dns)?;
            let mut seen = BTreeSet::new();
            let mut depth = 0;
            loop {
                if !seen.insert(name.to_ascii()) {
                    return Err(ErrorCode::Dns);
                }
                let response = self
                    .query(&name, kind, &mut queries, limits.max_dns_queries)
                    .await?;
                let mut current = name.clone();
                let mut advanced = false;
                loop {
                    let mut cname = None;
                    let before = result.len();
                    for record in response
                        .answers()
                        .iter()
                        .filter(|r| r.name() == &current && r.dns_class() == DNSClass::IN)
                    {
                        match record.data() {
                            Some(RData::A(a)) if kind == RecordType::A => {
                                result.insert(IpAddr::V4(a.0));
                            }
                            Some(RData::AAAA(a)) if kind == RecordType::AAAA => {
                                result.insert(IpAddr::V6(a.0));
                            }
                            Some(RData::CNAME(c)) => {
                                if cname.as_ref().is_some_and(|n| n != &c.0) {
                                    return Err(ErrorCode::Dns);
                                }
                                cname = Some(c.0.clone());
                            }
                            _ => {}
                        }
                    }
                    if result.len() > limits.max_dns_answers as usize {
                        return Err(ErrorCode::Dns);
                    }
                    if result.len() > before {
                        if cname.is_some() {
                            return Err(ErrorCode::Dns);
                        }
                        break;
                    }
                    match cname {
                        Some(next) => {
                            depth += 1;
                            if depth > limits.max_dns_cname_depth || next == current {
                                return Err(ErrorCode::Dns);
                            }
                            current = next;
                            advanced = true;
                        }
                        None => break,
                    }
                }
                if !advanced
                    || response
                        .answers()
                        .iter()
                        .any(|r| r.name() == &current && r.record_type() == kind)
                {
                    break;
                }
                name = current;
            }
        }
        if result.is_empty() {
            return Err(ErrorCode::Dns);
        }
        Ok(result.into_iter().collect())
    }
}
impl Resolver for OwnedDns {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        limits: &'a HttpLimits,
    ) -> BoxFuture<'a, Result<Vec<IpAddr>, Error>> {
        Box::pin(self.addresses(host, limits))
    }
}
fn check(response: &Message, id: u16, name: &Name, kind: RecordType) -> Result<(), Error> {
    if response.id() != id
        || response.message_type() != MessageType::Response
        || response.op_code() != OpCode::Query
        || response.response_code() != ResponseCode::NoError
        || response.queries().len() != 1
        || response.queries()[0].name() != name
        || response.queries()[0].query_type() != kind
        || response.queries()[0].query_class() != DNSClass::IN
    {
        return Err(ErrorCode::Dns);
    }
    Ok(())
}
