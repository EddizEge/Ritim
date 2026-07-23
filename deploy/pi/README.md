# Ritim Social Alpha.2 — Raspberry Pi

Bu klasör Alpha.2'nin ilk, henüz internete açılmayan Pi temelidir.

## Başlangıç

1. `.env.alpha2.example` dosyasını `.env` adıyla kopyala.
2. Üç farklı, uzun ve rastgele altyapı parolası ile en az 32 baytlık ayrı bir
   JWT imzalama anahtarı üret.
3. Google Cloud'da Ritim masaüstü/Android istemcileri için oluşturulan OAuth
   client ID değerlerini virgülle ayırarak `RITIM_GOOGLE_CLIENT_IDS` alanına
   yaz. İstemci secret'ını yalnızca confidential Web OAuth istemcisi
   kullanılıyorsa ekle.
4. Linux üzerinde secret dosyasını yalnızca sahibi okuyabilecek şekilde sınırla:

   ```sh
   chmod 600 .env
   ```

5. Yapılandırmayı doğrula:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml config
   ```

6. Servisleri derleyip başlat:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml up -d --build
   ```

7. Durumu denetle:

   ```sh
   docker compose --env-file .env -f compose.alpha2.yml ps
   curl --fail http://127.0.0.1:8790/ready
   ```

`RITIM_AUTH_REQUIRED=true` yalnızca PC ve Android istemcileri Ritim access
tokenı göndermeye başladıktan sonra açılmalıdır. Bu modda tokensız Socket.IO
bağlantıları reddedilir.

## Ağ sınırı

- PostgreSQL `5432` ve Redis `6379` yalnızca `ritim_backend` dahili ağındadır
  ve host'a yayınlanmaz.
- Gateway veritabanı için dahili ağa, loopback yayını için ayrı `ritim_edge`
  ağına bağlıdır.
- Gateway yalnızca Pi loopback adresinde `8790` portuna bağlanır.
- Bu compose dosyasında Cloudflare Tunnel yoktur.
- İstemci OAuth bağlantısı ve rate limit tamamlanmadan `0.0.0.0` bind veya
  Cloudflare public hostname eklenmez.

## Veri yerleşimi

İlk aşamada named volume'lar Pi'nin 128 GB SSD'sindeki Docker veri dizininde
kalır. 4 TB ve 2 TB diskler yedek/geri yükleme planı tamamlandığında ayrıca
salt yedek hedefleri olarak bağlanacaktır.
