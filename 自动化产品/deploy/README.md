# Dumate Studio Server Deploy

Recommended target directory:

```bash
/opt/dumate-studio
```

Start:

```bash
cd /opt/dumate-studio
chmod +x deploy/*.sh
deploy/start_server.sh
```

Stop:

```bash
cd /opt/dumate-studio
deploy/stop_server.sh
```

Status:

```bash
cd /opt/dumate-studio
deploy/status_server.sh
```

Default service port: `8787`.

Data protection rules for upgrades:

```bash
# Before restart, deploy/start_server.sh writes a timestamped snapshot under ./backups.
# Do not overwrite these runtime files with local empty files:
server/data.sqlite
server/data.sqlite-*
server/data.json
server/uploads/
server/composed/
```

When syncing code to the server, exclude runtime data:

```bash
rsync -av --exclude 'server/data.sqlite*' --exclude 'server/data.json' --exclude 'server/uploads/' --exclude 'server/composed/' --exclude 'server/logs/' ./ <ssh-target>:/opt/dumate-studio/
```

Docker deployments should mount a persistent data directory:

```bash
docker run -d --name dumate-studio -p 8787:8787 -v /opt/dumate-data:/data dumate-studio:latest
```
