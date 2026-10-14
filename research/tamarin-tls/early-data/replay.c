#include <openssl/ssl.h>
#include <openssl/err.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char payload[] = "owned-counter-increment";
static void fail(const char *where) { fprintf(stderr, "%s failed\n", where); ERR_print_errors_fp(stderr); exit(1); }
static void require(int ok, const char *where) { if (!ok) fail(where); }
static void bounded(int fd) {
  struct timeval t = {3, 0};
  require(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &t, sizeof(t)) == 0, "recv timeout");
  require(setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &t, sizeof(t)) == 0, "send timeout");
}
static const char *status(int s) {
  return s == SSL_EARLY_DATA_ACCEPTED ? "accepted" : s == SSL_EARLY_DATA_REJECTED ? "rejected" : "not-sent";
}
static SSL_CTX *context(int server) {
  SSL_CTX *ctx = SSL_CTX_new(server ? TLS_server_method() : TLS_client_method());
  require(ctx != NULL, "context");
  require(SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION), "min TLS");
  require(SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION), "max TLS");
  return ctx;
}
static void server_run(int listener, SSL_CTX *ctx, const char *mode) {
  for (int i = 0; i < 3; i++) {
    int fd = accept(listener, NULL, NULL); require(fd >= 0, "accept"); bounded(fd);
    SSL *ssl = SSL_new(ctx); require(ssl != NULL && SSL_set_fd(ssl, fd), "server SSL");
    char buffer[1024]; size_t got = 0, total = 0; int result;
    do {
      result = SSL_read_early_data(ssl, buffer + total, sizeof(buffer) - total, &got);
      total += got;
      require(total < sizeof(buffer), "early data bound");
    } while (result == SSL_READ_EARLY_DATA_SUCCESS);
    require(result == SSL_READ_EARLY_DATA_FINISH, "read early data");
    require(SSL_accept(ssl) == 1, "server handshake");
    require(SSL_version(ssl) == TLS1_3_VERSION, "server TLS version");
    require(total == 0 || (total == strlen(payload) && memcmp(buffer, payload, total) == 0), "owned payload");
    int es = SSL_get_early_data_status(ssl);
    printf("{\"side\":\"server\",\"mode\":\"%s\",\"connection\":%d,\"earlyData\":\"%s\",\"acceptedBytes\":%zu,\"resumed\":%s,\"protocol\":\"TLSv1.3\"}\n", mode, i, status(es), total, SSL_session_reused(ssl) ? "true" : "false"); fflush(stdout);
    // The byte forces the client to process post-handshake NewSessionTicket.
    require(SSL_write(ssl, "K", 1) == 1, "server acknowledgement");
    SSL_shutdown(ssl); SSL_free(ssl); close(fd);
  }
  SSL_CTX_free(ctx); close(listener); exit(0);
}
static SSL_SESSION *client_run(SSL_CTX *ctx, unsigned short port, SSL_SESSION *saved, const char *mode, int i) {
  int fd = socket(AF_INET, SOCK_STREAM, 0); require(fd >= 0, "client socket"); bounded(fd);
  struct sockaddr_in addr = {0}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); addr.sin_port = htons(port);
  require(connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0, "loopback connect");
  SSL *ssl = SSL_new(ctx); require(ssl != NULL && SSL_set_fd(ssl, fd), "client SSL");
  require(SSL_set1_host(ssl, "localhost"), "certificate host");
  require(SSL_set_tlsext_host_name(ssl, "localhost"), "SNI");
  if (saved) {
    // Reuse a duplicate of the ORIGINAL ticket, never a newly issued ticket.
    SSL_SESSION *copy = SSL_SESSION_dup(saved); require(copy != NULL, "session duplicate");
    require(SSL_set_session(ssl, copy), "set original session"); SSL_SESSION_free(copy);
    size_t written = 0;
    require(SSL_write_early_data(ssl, payload, strlen(payload), &written) == 1 && written == strlen(payload), "write early data");
  }
  require(SSL_connect(ssl) == 1, "client handshake");
  require(SSL_get_verify_result(ssl) == X509_V_OK && SSL_version(ssl) == TLS1_3_VERSION, "verified TLS");
  char ack = 0; require(SSL_read(ssl, &ack, 1) == 1 && ack == 'K', "read acknowledgement");
  printf("{\"side\":\"client\",\"mode\":\"%s\",\"connection\":%d,\"earlyData\":\"%s\",\"resumed\":%s,\"protocol\":\"TLSv1.3\",\"certificateVerified\":true}\n", mode, i, status(SSL_get_early_data_status(ssl)), SSL_session_reused(ssl) ? "true" : "false"); fflush(stdout);
  SSL_SESSION *session = SSL_get1_session(ssl); require(session != NULL, "save session");
  if (!saved) require(SSL_SESSION_get_max_early_data(session) >= strlen(payload), "early capable session ticket");
  SSL_shutdown(ssl); SSL_free(ssl); close(fd); return session;
}
int main(int argc, char **argv) {
  alarm(12); // Bound the client orchestration process.
  require(argc == 4, "arguments: cert key anti-replay|disabled-control");
  int disabled = strcmp(argv[3], "disabled-control") == 0;
  require(disabled || strcmp(argv[3], "anti-replay") == 0, "fixed mode");
  SSL_CTX *server = context(1), *client = context(0);
  require(SSL_CTX_use_certificate_file(server, argv[1], SSL_FILETYPE_PEM) == 1, "server certificate");
  require(SSL_CTX_use_PrivateKey_file(server, argv[2], SSL_FILETYPE_PEM) == 1 && SSL_CTX_check_private_key(server), "server key");
  require(SSL_CTX_set_max_early_data(server, 1024), "max early data");
  require(SSL_CTX_set_num_tickets(server, 1), "one ticket");
  if (disabled) SSL_CTX_set_options(server, SSL_OP_NO_ANTI_REPLAY);
  else SSL_CTX_clear_options(server, SSL_OP_NO_ANTI_REPLAY);
  SSL_CTX_set_verify(client, SSL_VERIFY_PEER, NULL);
  require(SSL_CTX_load_verify_locations(client, argv[1], NULL), "local trust root");
  int listener = socket(AF_INET, SOCK_STREAM, 0); require(listener >= 0, "listener");
  struct sockaddr_in addr = {0}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  require(bind(listener, (struct sockaddr *)&addr, sizeof(addr)) == 0 && listen(listener, 3) == 0, "loopback bind");
  socklen_t len = sizeof(addr); require(getsockname(listener, (struct sockaddr *)&addr, &len) == 0, "ephemeral port");
  fflush(NULL); pid_t child = fork(); require(child >= 0, "fork");
  if (child == 0) { alarm(12); SSL_CTX_free(client); server_run(listener, server, argv[3]); }
  close(listener); SSL_CTX_free(server);
  SSL_SESSION *original = client_run(client, ntohs(addr.sin_port), NULL, argv[3], 0);
  SSL_SESSION *later = client_run(client, ntohs(addr.sin_port), original, argv[3], 1); SSL_SESSION_free(later);
  later = client_run(client, ntohs(addr.sin_port), original, argv[3], 2); SSL_SESSION_free(later);
  SSL_SESSION_free(original); SSL_CTX_free(client);
  int child_status; require(waitpid(child, &child_status, 0) == child && WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0, "server completion");
  return 0;
}
