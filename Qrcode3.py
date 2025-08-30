#!/usr/bin/env python3
import sys
import os
import io
import requests
from PIL import Image
from pyzbar.pyzbar import decode

API_URL = "https://gerarqrcodepix.com.br/api/v1"

def gerar_qrcode_pix(chave: str, valor: float | None = None) -> Image.Image | None:
    params = {
        "nome": "None",
        "cidade": "São Paulo",
        "saida": "qr",
        "chave": chave
    }
    if valor is not None:
        params["valor"] = f"{valor:.2f}"

    try:
        resp = requests.get(API_URL, params=params, timeout=10)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content))
    except Exception as e:
        print(f"ERRO AO GERAR QR: {e}", file=sys.stderr)
        return None

def salvar_e_decodificar(chave: str, valor: float | None = None, nome_arquivo: str | None = None) -> tuple[str, str] | None:
    img = gerar_qrcode_pix(chave, valor)
    if img is None:
        return None

    pasta = os.path.join(os.path.dirname(__file__), "qrcodes")
    os.makedirs(pasta, exist_ok=True)

    if not nome_arquivo:
        nome_arquivo = f"{chave}.png"
    caminho = os.path.join(pasta, nome_arquivo)

    img.save(caminho)

    decoded = decode(img)
    if not decoded:
        return None

    payload = decoded[0].data.decode("utf-8").strip()
    return caminho, payload

def main():
    if len(sys.argv) < 2:
        print("Uso: python qrcode3.py CHAVE_PIX [VALOR] [NOME_ARQUIVO]", file=sys.stderr)
        sys.exit(1)

    chave = sys.argv[1]
    valor = None
    nome_arquivo = None

    if len(sys.argv) > 2:
        try:
            valor = float(sys.argv[2].replace(",", "."))
        except ValueError:
            print("ERRO: valor inválido.", file=sys.stderr)
            sys.exit(1)

    if len(sys.argv) > 3:
        nome_arquivo = sys.argv[3]

    resultado = salvar_e_decodificar(chave, valor, nome_arquivo)
    if not resultado:
        print("ERRO", file=sys.stderr)
        sys.exit(1)

    caminho_png, pix_payload = resultado
    print(caminho_png)      # 1ª linha: caminho do arquivo PNG salvo
    print(pix_payload)      # 2ª linha: código copiar e colar

if __name__ == "__main__":
    main()
