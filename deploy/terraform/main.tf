terraform {
  required_version = ">= 1.5"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.0"
    }
  }
}

provider "oci" {
  region = var.region
}

# --- VCN ---

resource "oci_core_vcn" "amds_vcn" {
  compartment_id = var.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "litedesk-amds-vcn"
  dns_label      = "litedeskvcn"
}

resource "oci_core_subnet" "private" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.amds_vcn.id
  cidr_block        = var.private_subnet_cidr
  display_name      = "amds-private"
  dns_label         = "private"
  prohibit_public_ip_on_vnic = true
}

# --- Security list (minimal — extend for your environment) ---

resource "oci_core_security_list" "amds" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.amds_vcn.id
  display_name   = "amds-compute"

  ingress_security_rules {
    protocol = "6"
    source   = var.litedesk_private_ip
    tcp_options {
      min = 8080
      max = 8080
    }
    description = "LiteDesk to AMDS gateway"
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
    description = "Public tracking redirects"
  }

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
    description = "SMTP + DNS egress"
  }
}

# --- AMDS compute (Ubuntu) ---

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = var.amds_instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "amds" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "amds-prod"
  shape               = var.amds_instance_shape

  shape_config {
    ocpus         = var.amds_ocpus
    memory_in_gbs = var.amds_memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.private.id
    assign_public_ip = false
    nsg_ids          = []
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(<<-EOF
      #!/bin/bash
      apt-get update && apt-get install -y docker.io docker-compose-plugin
      useradd -m -s /bin/bash amds || true
      mkdir -p /opt/amds
    EOF
    )
  }
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}
