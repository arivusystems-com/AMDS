output "amds_private_ip" {
  value       = oci_core_instance.amds.private_ip
  description = "AMDS gateway private IP for LiteDesk AMDS_BASE_URL"
}
