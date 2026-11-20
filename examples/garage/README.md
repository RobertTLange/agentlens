# Garage archive recipe

Local, single-node Garage for AgentLens development. It has no TLS: keep it on loopback or place it behind a TLS reverse proxy before configuring a non-local AgentLens uploader.

```bash
docker compose up -d
docker compose exec garage /garage status
docker compose exec garage /garage layout assign -z dc1 -c 1G <node-id>
docker compose exec garage /garage layout apply --version 1
docker compose exec garage /garage bucket create agentlens
docker compose exec garage /garage key create agentlens-uploader
docker compose exec garage /garage bucket allow --read --write agentlens --key agentlens-uploader
```

For local-only testing, use `endpoint = "http://localhost:3900"` plus `allowInsecureHttpEndpoint = true`. Production requires the TLS endpoint and keeps `allowInsecureHttpEndpoint = false`.

Garage data and metadata volumes are the archive. Back up both independently; AgentLens does not manage Garage upgrades, TLS, credentials, lifecycle rules, or backups.
