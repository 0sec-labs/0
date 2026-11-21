---
title: Self-hosting on Azure and AWS
description: Deploy the sovereign 0 container on Azure and AWS with persistent volumes, cloud secret stores, TLS ingress, automated backups, and upgrades.
---

Deploying 0 inside your organisation's cloud tenant ensures that code analysis, finding records, and model conversations stay entirely inside your security perimeter.

This guide details running the official container image (`ghcr.io/0sec-labs/0security`) on **Amazon Web Services (AWS)** and **Microsoft Azure**, using standard cloud building blocks: persistent block storage, managed secret stores, reverse proxy TLS termination, automated backups, and zero-downtime upgrades.

## Architecture and constraints

0 is designed as a sovereign, self-contained single-node application:

```
                  Internet / Corporate Network
                               │
                               ▼
               ┌───────────────────────────────┐
               │    TLS Ingress (Ports 80/443) │
               │     Caddy, AWS ALB, or AGW    │
               └───────────────┬───────────────┘
                               │ HTTPS / Reverse Proxy
                               ▼
               ┌───────────────────────────────┐
               │   0 Server Container (Docker) │
               │   Runs as non-root (uid 1000) │
               │      Binds 127.0.0.1:48123    │
               └───────────────┬───────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
       ┌───────────────┐               ┌───────────────┐
       │   /data       │               │ Cloud Secrets │
       │  EBS / Azure  │               │ AWS SSM / SM  │
       │ Managed Disk  │               │ Azure KeyVlt  │
       └───────────────┘               └───────────────┘
```

### The single-node rule

- The 0 web console in server mode uses an embedded SQLite database located at `/data/.0/0.db`.
- **Run strictly one replica.** SQLite requires single-process ownership. Never mount the persistent volume to multiple containers or run multi-replica clusters.
- High availability is achieved through virtual machine automated recovery, storage volume snapshots, and scheduled database backups rather than multi-master clustering.

### Sizing guidelines

| Sizing | vCPU | RAM | Storage | Typical Cloud Instance |
|---|---|---|---|---|
| **Minimum** | 2 | 4 GB | 30 GB SSD | AWS `t3.medium`, Azure `Standard_B2s` |
| **Standard** | 4 | 8 GB | 60 GB SSD | AWS `t3.xlarge` / `m7g.large`, Azure `Standard_D2s_v5` |
| **High load** | 8 | 16 GB | 120 GB SSD | AWS `m7g.xlarge`, Azure `Standard_D4s_v5` |

Add roughly 1 vCPU and 1 to 2 GB memory for each concurrent scan or fix thread.

---

## AWS Deployment

### Method 1: Amazon EC2 with Docker Compose (Recommended)

Running on EC2 with Docker Compose and an attached Amazon Elastic Block Store (EBS) volume is the most straightforward self-hosted configuration.

#### 1. Provision storage and compute

1. **EC2 Instance:** Launch an instance with Ubuntu 24.04 LTS (e.g. `t3.xlarge` or `m7g.large` with ARM64 / x86_64).
2. **EBS Data Volume:** Attach an Amazon EBS `gp3` volume (e.g. 50 GB) as `/dev/sdf` for application state.
3. **Format and Mount:**
   ```bash
   sudo mkfs -t ext4 /dev/nvme1n1 # or /dev/xvdf depending on instance generation
   sudo mkdir -p /data
   sudo mount /dev/nvme1n1 /data
   echo "/dev/nvme1n1 /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo chown -R 1000:1000 /data
   sudo chmod 700 /data
   ```

#### 2. IAM role and secrets management

Never store long-lived cloud or model credentials in plain text git repositories. Use **AWS Systems Manager (SSM) Parameter Store** or **AWS Secrets Manager**.

1. Store configuration parameters:
   ```bash
   aws ssm put-parameter --name "/zero/ZERO_ACCESS_TOKEN" --type "SecureString" --value "$(openssl rand -base64 32)"
   aws ssm put-parameter --name "/zero/ANTHROPIC_API_KEY" --type "SecureString" --value "sk-ant-..."
   aws ssm put-parameter --name "/zero/GH_TOKEN" --type "SecureString" --value "ghp_..."
   ```

2. Attach an IAM role to the EC2 instance with read access:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "ssm:GetParametersByPath",
           "ssm:GetParameter"
         ],
         "Resource": "arn:aws:ssm:*:*:parameter/zero/*"
       }
     ]
   }
   ```

3. Fetch secrets into the runtime environment on container startup:
   ```bash
   mkdir -p /opt/zero
   aws ssm get-parameters-by-path --path "/zero/" --with-decryption \
     --query "Parameters[*].[Name,Value]" --output text | \
     while read -r name val; do
       var_name=$(basename "$name")
       echo "${var_name}=${val}"
     done > /opt/zero/.env
   chmod 600 /opt/zero/.env
   ```

#### 3. Run the application

Clone the repository deployment assets or copy `deploy/compose/`:

```bash
cd /opt/zero
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/deploy/compose/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/deploy/compose/Caddyfile -o Caddyfile
```

Configure your domain and network parameters in `/opt/zero/.env`:

```bash
ZERO_DOMAIN=zero.internal.yourcompany.com
ZERO_PUBLIC_URL=https://zero.internal.yourcompany.com
ZERO_ALLOWED_HOSTS=zero.internal.yourcompany.com
ZERO_IMAGE_TAG=v0.41.0
```

Start the container with automatic TLS via Caddy:

```bash
docker compose --profile proxy up -d
```

Verify service health:

```bash
curl -fsS http://127.0.0.1:48123/readyz
```

---

### Method 2: AWS Elastic Container Service (ECS)

For container-native environments without managing host operating systems:

1. **ECS Cluster:** Create an ECS cluster using the EC2 launch type (allows EBS volume attachments).
2. **Task Definition:** Define a single container task using `ghcr.io/0sec-labs/0security:v0.41.0`:
   - Set container mount: Host `/data` mounted to container `/data`.
   - Set `secrets` mapping directly from AWS Secrets Manager or SSM Parameter Store to environment variables (`ZERO_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, etc.).
   - Configure health check: `curl -fsS http://127.0.0.1:48123/healthz || exit 1`.
3. **Service Deployment:** Create an ECS Service with `desiredCount: 1`. Set minimum healthy percent to `0` and maximum percent to `100` so ECS does not attempt to launch a second simultaneous container on the same volume during deployments.

---

## Azure Deployment

### Method 1: Azure Virtual Machine with Docker Compose

#### 1. Compute and disk setup

1. **Virtual Machine:** Deploy an Azure VM running Ubuntu 24.04 LTS (e.g. `Standard_D2s_v5`).
2. **Data Disk:** Attach a Premium SSD Managed Data Disk (e.g. 64 GB, LRS).
3. **Mount the disk:**
   ```bash
   sudo parted /dev/sdc --script mklabel gpt mkpart xfspart ext4 0% 100%
   sudo mkfs.ext4 /dev/sdc1
   sudo mkdir -p /data
   sudo mount /dev/sdc1 /data
   echo "/dev/sdc1 /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo chown -R 1000:1000 /data
   sudo chmod 700 /data
   ```

#### 2. Azure Key Vault integration

1. Enable a **System-Assigned Managed Identity** on the Azure VM.
2. In Azure Key Vault, grant the VM's identity the **Key Vault Secrets User** role.
3. Store application secrets in Key Vault:
   - `ZERO-ACCESS-TOKEN`
   - `AZURE-OPENAI-API-KEY`
   - `GH-TOKEN`
4. Pull secrets into `.env` at startup:
   ```bash
   az login --identity --allow-no-subscriptions
   TOKEN=$(az keyvault secret show --vault-name "kv-zero-prod" --name "ZERO-ACCESS-TOKEN" --query value -o tsv)
   KEY=$(az keyvault secret show --vault-name "kv-zero-prod" --name "AZURE-OPENAI-API-KEY" --query value -o tsv)

   cat <<EOF > /opt/zero/.env
   ZERO_ACCESS_TOKEN=${TOKEN}
   AZURE_OPENAI_API_KEY=${KEY}
   ZERO_DOMAIN=zero.azure.yourcompany.com
   ZERO_PUBLIC_URL=https://zero.azure.yourcompany.com
   ZERO_ALLOWED_HOSTS=zero.azure.yourcompany.com
   EOF
   chmod 600 /opt/zero/.env
   ```

#### 3. Ingress and firewall

- In the Network Security Group (NSG), allow inbound traffic on TCP ports 80 and 443.
- Run `docker compose --profile proxy up -d` to terminate TLS via Caddy.
- Alternatively, place an **Azure Application Gateway** or **Azure Front Door** in front of port 48123 and configure `ZERO_TRUSTED_PROXY` to trust the gateway subnet.

---

## Scheduled Backups and Restore

Because findings and audit logs reside in the SQLite database (`/data/.0/0.db`), regular backups are essential.

### 1. Online safe database backup

Never copy an active SQLite database file directly while queries are running. Use the Node.js SQLite backup API to take an atomic online backup without stopping the container:

```bash
docker compose exec zero node -e "
const { DatabaseSync, backup } = require('node:sqlite');
(async () => {
  const db = new DatabaseSync('/data/.0/0.db', { readOnly: true });
  await backup(db, '/data/backup.db');
  db.close();
})()"
```

Extract the backup and set permissions:

```bash
docker compose cp zero:/data/backup.db ./zero-backup-$(date +%F).db
docker compose exec zero rm -f /data/backup.db
chmod 600 zero-backup-*.db
```

### 2. Offsite upload to cloud object storage

Schedule a daily cron job to run the backup and push it to object storage:

- **AWS S3:**
  ```bash
  aws s3 cp ./zero-backup-$(date +%F).db s3://my-org-zero-backups/$(date +%Y)/$(date +%m)/backup-$(date +%F).db \
    --sse aws:kms --sse-kms-key-id alias/zero-backup-key
  ```

- **Azure Blob Storage:**
  ```bash
  az storage blob upload \
    --account-name "zeroorgbackups" \
    --container-name "db-backups" \
    --file "./zero-backup-$(date +%F).db" \
    --name "$(date +%Y)/$(date +%m)/backup-$(date +%F).db" \
    --auth-mode login
  ```

### 3. Cloud disk snapshots

Configure automated storage-layer snapshots for disaster recovery:
- **AWS:** Create an Amazon Data Lifecycle Manager (DLM) policy to take daily snapshots of the `/data` EBS volume with a 14-day retention rule.
- **Azure:** Configure Azure Backup or a disk snapshot policy for the managed data disk.

### 4. Tested step-by-step restore procedure

To restore from a backup:

1. **Stop the running service:**
   ```bash
   docker compose stop zero
   ```

2. **Restore the database:**
   ```bash
   sudo cp ./zero-backup-2026-11-21.db /data/.0/0.db
   sudo chown 1000:1000 /data/.0/0.db
   sudo chmod 600 /data/.0/0.db
   ```

3. **Restart the container:**
   ```bash
   docker compose start zero
   ```

4. **Verify instance health:**
   ```bash
   curl -fsS http://127.0.0.1:48123/readyz
   ```
   The endpoint returns `{"status":"ok"}`.

---

## Upgrades and Rollbacks

### Upgrades

1. Always take a fresh backup before upgrading:
   ```bash
   docker compose exec zero node -e "const {DatabaseSync,backup}=require('node:sqlite');(async()=>{const db=new DatabaseSync('/data/.0/0.db',{readOnly:true});await backup(db,'/data/backup.db');db.close()})()"
   docker compose cp zero:/data/backup.db ./pre-upgrade-backup.db
   ```
2. Update the image tag in `/opt/zero/.env` (e.g. `ZERO_IMAGE_TAG=v0.42.0`).
3. Recreate the container:
   ```bash
   docker compose pull zero
   docker compose up -d zero
   ```
4. Database migrations run automatically during startup. Inspect the startup log:
   ```bash
   docker compose logs --tail 50 zero
   ```

### Rollbacks

Because SQLite schema migrations are forward-only, rolling back to an older version requires restoring the pre-upgrade database state:

1. Stop the container:
   ```bash
   docker compose stop zero
   ```
2. Revert the database file:
   ```bash
   sudo cp ./pre-upgrade-backup.db /data/.0/0.db
   sudo chown 1000:1000 /data/.0/0.db
   sudo chmod 600 /data/.0/0.db
   ```
3. Pin the previous image tag in `/opt/zero/.env` (e.g. `ZERO_IMAGE_TAG=v0.41.0`).
4. Recreate the container with the older image:
   ```bash
   docker compose up -d zero
   ```

---

## Security Hardening Checklist

- [x] **Non-root container execution:** 0 runs under user `ubuntu` (uid 1000). Never override with `user: root`.
- [x] **Least privilege volume access:** Mount host volume with mode `0700` owned by `1000:1000`.
- [x] **Protect loopback bind:** When running behind a local reverse proxy (Caddy), bind container port to `127.0.0.1:48123` only. Never expose port 48123 to `0.0.0.0` without TLS termination.
- [x] **DNS rebinding protection:** Configure `ZERO_ALLOWED_HOSTS` to exactly match your public hostname. Unrecognized `Host` headers receive HTTP 403 Forbidden.
- [x] **Secure cookie policy:** Set `ZERO_PUBLIC_URL=https://...` so session cookies are stamped with the `Secure` attribute.
