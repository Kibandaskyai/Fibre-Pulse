# FibrePulse Connector Agent (MikroTik)

Runs inside the ISP network, reads MikroTik routers over the RouterOS 7 REST API and reports to FibrePulse over signed HTTPS. Full guide, router user setup and security model: [docs/MIKROTIK_INTEGRATION.md](../../docs/MIKROTIK_INTEGRATION.md).

```bash
npm install && npm run build
cp .env.example .env        # FIBREPULSE_URL and the token from Network Monitoring > Connectors
npm start                   # runs continuously
npm run once                # one sync, poll and report, then exit
```

Docker: `docker build -t fibrepulse-agent . && docker run --env-file .env --restart unless-stopped fibrepulse-agent`
systemd: copy `fibrepulse-agent.service` to `/etc/systemd/system/`, adjust paths, `systemctl enable --now fibrepulse-agent`.

Router writes are off unless `ALLOW_ROUTER_WRITES=true` **and** the ISP owner turned on router disconnect in FibrePulse. Only PPPoE secret disable/enable and removing the active session are ever done.
