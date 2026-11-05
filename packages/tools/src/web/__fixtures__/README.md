# Test fixtures

`test-tls.crt` / `test-tls.key`: a self-signed certificate for `secure.test`, used only by
`http-client.test.ts` to check that TLS host-name verification still works while connections
are pinned to a validated IP address. The key protects nothing and is not used by the app.

Regenerate (valid for 100 years):

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 36500 -nodes \
  -subj "/CN=secure.test" -addext "subjectAltName=DNS:secure.test" \
  -keyout test-tls.key -out test-tls.crt
```
