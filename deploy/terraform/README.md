# OCI Terraform skeleton — AMDS + LiteDesk same VCN

This is a **starting point**, not a production-ready module. Customize `terraform.tfvars` before apply.

## Prerequisites

- [Terraform](https://www.terraform.io/) 1.5+
- OCI API key + `~/.oci/config`
- Compartment OCID

## Usage

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your OCIDs and CIDRs
terraform init
terraform plan
terraform apply
```

## What it creates (intended)

- VCN with public + private subnets
- Security lists:
  - LiteDesk private IP → AMDS `:8080`
  - AMDS → LiteDesk webhook
  - AMDS egress `:25`, `:587`, `:53`
  - Public `:443` for tracking redirects only
- AMDS compute instance in private subnet
- Optional public IP for tracking/bounce endpoints

## Not included (manual / follow-up)

- Managed PostgreSQL / Redis (co-locate on compute for MVP or add OCI services)
- Load balancer (Track 5 post-MVP)
- DNS zones (apply separately)
- Port 25 unblock (OCI support ticket — open early)

See [BUILD-TO-DEPLOY.md](../../docs/BUILD-TO-DEPLOY.md) for full deploy checklist.
