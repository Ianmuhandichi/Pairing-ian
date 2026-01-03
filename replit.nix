# IAN TECH Global WhatsApp Pairing Service
# Nix configuration for Replit

{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.ffmpeg
    pkgs.git
    pkgs.openssl
    pkgs.zlib
    pkgs.qrencode
    pkgs.libphonenumber
  ];
  
  env = {
    COMPANY_NAME = "IAN TECH";
    CONTACT_PHONE = "+254723278526";
    COMPANY_EMAIL = "contact@iantech.co.ke";
    COMPANY_WEBSITE = "https://iantech.co.ke";
    PORT = "5000";
    NODE_ENV = "production";
    AUTO_ACTIVATED = "true";
    PATH = "/home/runner/.npm-packages/bin:$PATH";
  };
}
