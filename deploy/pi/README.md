# Ritim Social Alpha.2 — Raspberry Pi

Bu klasör Alpha.2'nin ilk, henüz internete açılmayan Pi temelidir.

## Başlangıç

1. `.env.alpha2.example` dosyasını `.env` adıyla kopyala.
2. Üç farklı, uzun ve rastgele parola üret.
3. Linux üzerinde secret dosyasını yalnızca sahibi okuyabilecek şekilde sınırla:

   ```sh
   chmod 600 .env
   ```

4. Yapılandırmayı doğrula:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml config
   ```

5. Servisleri derleyip başlat:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml up -d --build
   ```

6. Durumu denetle:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml ps
   curl --fail http://127.0.0.1:8790/ready
   ```

## Ağ sınırı

- PostgreSQL `5432` ve Redis `6379` yalnızca `ritim_backend` dahili ağındadır
  ve host'a yayınlanmaz.
- Gateway veritabanı için dahili ağa, loopback yayını için ayrı `ritim_edge`
  ağına bağlıdır.
- Gateway yalnızca Pi loopback adresinde `8790` portuna bağlanır.
- Bu compose dosyasında Cloudflare Tunnel yoktur.
- OAuth, token doğrulama ve rate limit tamamlanmadan `0.0.0.0` bind veya
  Cloudflare public hostname eklenmez.

## Veri yerleşimi

İlk aşamada named volume'lar Pi'nin 128 GB SSD'sindeki Docker veri dizininde
kalır. 4 TB ve 2 TB diskler yedek/geri yükleme planı tamamlandığında ayrıca
salt yedek hedefleri olarak bağlanacaktır.
