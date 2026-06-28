# Dumate Studio Server Deploy

Recommended target directory:

```bash
/home/wangduan/dumate-studio
```

Start:

```bash
cd /home/wangduan/dumate-studio
chmod +x deploy/*.sh
deploy/start_server.sh
```

Stop:

```bash
cd /home/wangduan/dumate-studio
deploy/stop_server.sh
```

Status:

```bash
cd /home/wangduan/dumate-studio
deploy/status_server.sh
```

Default service port: `8787`.

Open from the same intranet if BCC security group and relay allow it:

```text
http://<BCC_HOST_OR_IP>:8787/#/overview
```

If the page cannot be reached, ask the BCC/WebRelay owner to open or map TCP port `8787`.
