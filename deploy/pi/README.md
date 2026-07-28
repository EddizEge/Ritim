# Ritim Social Alpha.2 — Raspberry Pi

Bu klasör Alpha.2'nin Raspberry Pi üzerindeki kalıcı sosyal altyapısıdır.

## Başlangıç

1. `.env.alpha2.example` dosyasını `.env` adıyla kopyala.
2. Üç farklı, uzun ve rastgele altyapı parolası ile en az 32 baytlık ayrı bir
   JWT imzalama anahtarı üret.
3. Google Cloud'da Ritim masaüstü/Android istemcileri için oluşturulan OAuth
   client ID değerlerini virgülle ayırarak `RITIM_GOOGLE_CLIENT_IDS` alanına
   yaz. İstemci türü token değişiminde secret gerektiriyorsa
   `RITIM_GOOGLE_CLIENT_SECRET` alanına ekle.
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

## Alpha.3 mesaj istekleri geçişi

Mevcut Alpha.2 PostgreSQL volume'u ilk kurulum betiklerini tekrar çalıştırmaz.
Alpha.3 gateway imajına geçmeden önce `030_alpha3_message_requests.sql`
dosyasını bir kez yönetici hesabıyla uygula:

```sh
docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/030_alpha3_message_requests.sql

docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/040_alpha3_notifications.sql
```

Geçiş eski birebir konuşmaları kabul edilmiş ilişki olarak korur; mesajları
silmez veya yeniden yazmaz. Betik tekrar çalıştırılabilir.

`RITIM_AUTH_REQUIRED=true` yalnızca PC ve Android istemcileri Ritim access
tokenı göndermeye başladıktan sonra açılmalıdır. Bu modda tokensız Socket.IO
bağlantıları reddedilir.

Üretim Windows ve Android paketleri varsayılan olarak
`https://social.edizegemercan.com.tr` adresini kullanır. Geliştirmede gateway
adresi `RITIM_SOCIAL_URL` veya `VITE_SOCIAL_URL` ile değiştirilebilir. Telefon
ayrıca Google tokenı almaz; eşlenmiş PC'den tek kullanımlık companion ticket
alarak aynı Ritim hesabına bağlanır.

## Ağ sınırı

- PostgreSQL `5432` ve Redis `6379` yalnızca `ritim_backend` dahili ağındadır
  ve host'a yayınlanmaz.
- Gateway veritabanı için dahili ağa, loopback yayını için ayrı `ritim_edge`
  ağına bağlıdır.
- Gateway yalnızca Pi loopback adresinde `8790` portuna bağlanır.
- Cloudflare Tunnel ayrı CasaOS container'ında çalışır ve
  `social.edizegemercan.com.tr` adresini `http://127.0.0.1:8790` originine
  yönlendirir.
- Gateway origin allowlist, HTTP/auth/socket bağlantı limitleri, olay başına
  hız sınırları ve kimlik doğrulaması ile korunur.
- Cloudflare rotasında `RITIM_TRUST_PROXY=1` kullanılır; gateway yine
  `0.0.0.0` üzerinde host'a yayınlanmaz.

## Veri yerleşimi

Named volume'lar Pi'nin 128 GB SSD'sindeki Docker veri dizininde kalır.
`backup/ritim-backup.sh` PostgreSQL custom-format çıktısını AES-256-CBC/PBKDF2
ile şifreleyip atomik olarak hedefe taşır; düz veritabanı dökümü diske yazılmaz.

- Günlük yedek: 4 TB diskte `RitimBackups/daily`, 14 gün
- Haftalık geri yükleme noktası: 2 TB diskte `RitimBackups/weekly`, 180 gün
- Haftalık servis yedeği geçici `ritim_restore_smoke` veritabanına gerçekten
  geri yükler, temel tablo sayılarını doğrular ve geçici veritabanını siler.
- Şifreleme parolası `/DATA/AppData/ritim-alpha2/secrets/backup-passphrase`
  dosyasında, yalnızca root erişimiyle tutulur.

`systemd/` altındaki service/timer dosyaları Pi'ye kurulduğunda Cloudflare'dan
bağımsız olarak bu takvimi uygular. Gateway internete yalnızca Cloudflare
HTTPS/WSS rotası, zorunlu Ritim kimlik doğrulaması ve hız sınırlarıyla açılır.
