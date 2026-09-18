#![allow(clippy::unwrap_used)]
mod common;
use common::*;
use hickory_proto::{
    op::{Message, MessageType},
    rr::{Name, RData, Record, RecordType, rdata::A},
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;
use zero_http::*;
fn reply(q: &Message, ip: bool) -> Message {
    let mut r = Message::new();
    r.set_id(q.id())
        .set_message_type(MessageType::Response)
        .add_query(q.queries()[0].clone());
    if ip {
        r.add_answer(Record::from_rdata(
            q.queries()[0].name().clone(),
            10,
            RData::A(A("127.0.0.1".parse().unwrap())),
        ));
    }
    r
}
#[tokio::test]
async fn owned_dns_udp_all_families_and_pinned_real_target() {
    let dns = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = dns.local_addr().unwrap();
    let dnsjob = tokio::spawn(async move {
        let mut queries = Vec::new();
        for _ in 0..2 {
            let mut buf = [0; 4096];
            let (n, peer) = dns.recv_from(&mut buf).await.unwrap();
            let q = Message::from_vec(&buf[..n]).unwrap();
            queries.push(q.queries()[0].query_type());
            let mut r = reply(&q, q.queries()[0].query_type() == RecordType::A);
            r.add_additional(Record::from_rdata(
                Name::from_ascii("unrelated.test.").unwrap(),
                10,
                RData::A(A("10.0.0.1".parse().unwrap())),
            ));
            dns.send_to(&r.to_vec().unwrap(), peer).await.unwrap();
        }
        queries
    });
    let (port, target) = server(response(200, "", b"owned DNS")).await;
    let p = policy(format!("http://127.0.0.1:{port}"));
    let c = Client::with_runtime(
        p,
        None,
        Arc::new(OwnedDns::new(addr, BTreeMap::new()).unwrap()),
        Arc::new(MonotonicClock::default()),
        None,
    )
    .unwrap();
    let out = c
        .execute(
            c.prepare(args(&format!("http://example.test:{port}/")))
                .unwrap(),
            CancellationToken::new(),
            &Hooks::default(),
        )
        .await;
    assert_eq!(out.disposition, HttpDisposition::CompleteResponse);
    assert_eq!(dnsjob.await.unwrap(), vec![RecordType::A, RecordType::AAAA]);
    assert!(String::from_utf8_lossy(&target.await.unwrap()).contains("host: example.test:"));
}
#[tokio::test]
async fn dns_tcp_truncation_fallback_and_wrong_identity_rejection() {
    for wrong_id in [false, true] {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let udp = UdpSocket::bind(addr).await.unwrap();
        let job = tokio::spawn(async move {
            let mut b = [0; 4096];
            let (n, peer) = udp.recv_from(&mut b).await.unwrap();
            let q = Message::from_vec(&b[..n]).unwrap();
            let mut r = reply(&q, false);
            if wrong_id {
                r.set_id(q.id().wrapping_add(1));
                udp.send_to(&r.to_vec().unwrap(), peer).await.unwrap();
                return;
            }
            r.set_truncated(true);
            udp.send_to(&r.to_vec().unwrap(), peer).await.unwrap();
            let (mut socket, _) = tcp.accept().await.unwrap();
            let n = socket.read_u16().await.unwrap() as usize;
            let mut bytes = vec![0; n];
            socket.read_exact(&mut bytes).await.unwrap();
            let q = Message::from_vec(&bytes).unwrap();
            let b = reply(&q, true).to_vec().unwrap();
            socket.write_u16(b.len() as u16).await.unwrap();
            socket.write_all(&b).await.unwrap();
            let mut buffer = [0; 4096];
            let (n, peer) = udp.recv_from(&mut buffer).await.unwrap();
            let q = Message::from_vec(&buffer[..n]).unwrap();
            udp.send_to(&reply(&q, false).to_vec().unwrap(), peer)
                .await
                .unwrap();
        });
        let resolver = OwnedDns::new(addr, BTreeMap::new()).unwrap();
        let limits = policy("http://127.0.0.1".into()).limits;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            resolver.resolve("example.test", &limits),
        )
        .await
        .unwrap();
        if wrong_id {
            assert_eq!(result.unwrap_err(), ErrorCode::Dns);
        } else {
            assert_eq!(
                result.unwrap(),
                vec!["127.0.0.1".parse::<std::net::IpAddr>().unwrap()]
            );
        }
        job.await.unwrap();
    }
}
struct TestClock {
    now: AtomicU64,
    changed: Notify,
}
impl TestClock {
    fn advance(&self, n: u64) {
        self.now.store(n, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}
impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep_until(&self, deadline: u64) -> futures_util::future::BoxFuture<'_, ()> {
        Box::pin(async move {
            loop {
                let wait = self.changed.notified();
                tokio::pin!(wait);
                wait.as_mut().enable();
                if self.now_ms() >= deadline {
                    return;
                }
                wait.await;
            }
        })
    }
}
#[tokio::test]
async fn deadline_drops_owned_dns_and_late_answer_never_dispatches() {
    let dns = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = dns.local_addr().unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let clock = Arc::new(TestClock {
        now: AtomicU64::new(0),
        changed: Notify::new(),
    });
    let c = Client::with_runtime(
        policy(format!("http://127.0.0.1:{port}")),
        None,
        Arc::new(OwnedDns::new(addr, BTreeMap::new()).unwrap()),
        clock.clone(),
        None,
    )
    .unwrap();
    let h = Arc::new(Hooks::default());
    let hc = h.clone();
    let run = tokio::spawn(async move {
        c.execute(
            c.prepare(args(&format!("http://example.test:{port}/")))
                .unwrap(),
            CancellationToken::new(),
            hc.as_ref(),
        )
        .await
    });
    let mut buf = [0; 4096];
    let (n, peer) = dns.recv_from(&mut buf).await.unwrap();
    let q = Message::from_vec(&buf[..n]).unwrap();
    clock.advance(1001);
    let out = run.await.unwrap();
    assert_eq!(out.error, Some(ErrorCode::Deadline));
    assert_eq!(out.dispatch, DispatchState::NeverDispatched);
    dns.send_to(&reply(&q, true).to_vec().unwrap(), peer)
        .await
        .unwrap();
    assert!(h.admitted.lock().unwrap().is_empty());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), target.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn cname_chain_is_followed_but_cycles_and_wrong_questions_fail() {
    use hickory_proto::rr::rdata::{AAAA, CNAME};
    for mode in 0..3 {
        let dns = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = dns.local_addr().unwrap();
        let job = tokio::spawn(async move {
            for _ in 0..if mode == 0 { 2 } else { 1 } {
                let mut b = [0; 4096];
                let (n, peer) = dns.recv_from(&mut b).await.unwrap();
                let q = Message::from_vec(&b[..n]).unwrap();
                let mut r = reply(&q, false);
                if mode == 2 {
                    r.queries_mut()[0].set_name(Name::from_ascii("wrong.test.").unwrap());
                } else {
                    let name = q.queries()[0].name().clone();
                    let alias = if mode == 1 {
                        name.clone()
                    } else {
                        Name::from_ascii("alias.test.").unwrap()
                    };
                    r.add_answer(Record::from_rdata(
                        name,
                        10,
                        RData::CNAME(CNAME(alias.clone())),
                    ));
                    if mode == 0 {
                        let data = if q.queries()[0].query_type() == RecordType::A {
                            RData::A(A("127.0.0.1".parse().unwrap()))
                        } else {
                            RData::AAAA(AAAA("::1".parse().unwrap()))
                        };
                        r.add_answer(Record::from_rdata(alias, 10, data));
                    }
                }
                dns.send_to(&r.to_vec().unwrap(), peer).await.unwrap();
            }
        });
        let resolver = OwnedDns::new(addr, BTreeMap::new()).unwrap();
        let limits = policy("http://127.0.0.1".into()).limits;
        let result = resolver.resolve("example.test", &limits).await;
        if mode == 0 {
            assert_eq!(result.unwrap().len(), 2);
        } else {
            assert_eq!(result.unwrap_err(), ErrorCode::Dns);
        }
        job.await.unwrap();
    }
}
