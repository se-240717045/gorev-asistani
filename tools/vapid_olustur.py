"""
Push bildirimleri için VAPID anahtar çifti üretir.

Çalıştır:   python tools/vapid_olustur.py
(Gerekli paket: pip install cryptography)

Çıktıdaki:
  - GENEL anahtarı  → docs/config.js içindeki VAPID_PUBLIC_KEY alanına
  - ÖZEL anahtarı   → GitHub → Settings → Secrets → VAPID_PRIVATE_KEY
ÖZEL anahtarı kimseyle paylaşma ve koda yazma.
"""

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


key = ec.generate_private_key(ec.SECP256R1())
private_raw = key.private_numbers().private_value.to_bytes(32, "big")
public_raw = key.public_key().public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
)

print("GENEL anahtar (VAPID_PUBLIC_KEY):")
print(b64url(public_raw))
print()
print("ÖZEL anahtar (VAPID_PRIVATE_KEY — gizli tut!):")
print(b64url(private_raw))
