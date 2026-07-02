variable "compartment_id" {
  type        = string
  description = "OCI compartment OCID"
}

variable "region" {
  type        = string
  description = "OCI region e.g. ap-mumbai-1"
}

variable "vcn_cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "VCN CIDR block"
}

variable "private_subnet_cidr" {
  type    = string
  default = "10.0.2.0/24"
}

variable "amds_instance_shape" {
  type    = string
  default = "VM.Standard.E4.Flex"
}

variable "amds_ocpus" {
  type    = number
  default = 2
}

variable "amds_memory_gb" {
  type    = number
  default = 8
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key for compute access"
}

variable "litedesk_private_ip" {
  type        = string
  description = "LiteDesk private IP allowed to reach AMDS gateway"
}
