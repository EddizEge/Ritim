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

Alpha.4 oda üyeliği geçişi:

```sh
docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/050_alpha4_room_membership.sql
```

Alpha.4 oda sohbeti geçişi (Dilim 5):

```sh
docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/060_alpha4_room_interactions.sql
```

`060` geçişi yalnızca kısa oda mesajı tablosunu ve gerekli izinleri ekler.
Gateway imajını yenilemeden önce bir kez uygulanmalıdır; Cloudflare ayarında
değişiklik gerektirmez.

Beta 1 Ayarlar güvenli şikâyet özeti geçişi:

```sh
docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/070_beta1_settings.sql
```

`070` geçişi önce eski tablo düzeyi okuma yetkisini geri alır, ardından
`ritim_app` rolüne yalnız şikâyet sahibini, hedefi, nedeni ve oluşturulma
zamanını okuyacak sütun izinlerini verir. Şikâyet açıklaması,
ileti bağlamı, iç moderasyon durumu ve dahili kimlikler uygulama rolüne
açılmaz. Betik idempotenttir; Beta 1 gateway imajından önce bir kez
uygulanmalıdır. Sistem bildirimi izni cihaz yerelinde tutulur; veritabanındaki
eski `device_enabled` sütunu Beta 1 gateway'i tarafından okunmaz veya
güncellenmez.

Geçiş eski birebir konuşmaları kabul edilmiş ilişki olarak korur; mesajları
silmez veya yeniden yazmaz. Betik tekrar çalıştırılabilir.

Beta 2 mesaj izni geçişi:

```sh
docker compose --env-file .env -f compose.alpha2.yml exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < postgres/init/080_beta2_message_permissions.sql
```

`080` geçişi `ritim_app` rolüne yalnız `ritim.messages.deleted_at` sütununda
`UPDATE` yetkisi verir. Bu yetki olmadan mesaj isteğini reddetmek (yumuşak
silme) ve mesaja tepki vermek (`SELECT ... FOR UPDATE` kilidi) PostgreSQL
modunda `permission denied` ile başarısız oluyordu. Mesaj gövdesi ve kimlik
sütunları değiştirilemez kalır. Betik idempotenttir; önce şifreli yedek alınıp
Beta 2 gateway imajından önce bir kez uygulanmalıdır. Geçici bir ortamda uçtan
uca doğrulama için `RITIM_AUTH_REQUIRED=false` ile başlatılan gateway'e karşı
`RITIM_SOCIAL_TEST_URL=<adres> node --test tests/social-gateway-message-requests.test.cjs`
çalıştırılabilir; üretim gateway'ine bu test yöneltilmez.

CI'daki `social-gateway` işi aynı opt-in testleri her çalıştırmada geçici
PostgreSQL 17 + Redis 7 container'larına karşı koşar:
`bash deploy/ci/social-gateway-e2e.sh`. Betik bu klasördeki `init` geçişlerini
sıfır veritabanına uygular, 020+ geçişlerini bir kez daha uygulayarak
tekrar çalıştırılabilirliği denetler, tokensız ve kimlik zorunlu iki gateway
başlatır; kimlik testinin tokenı sahte bir Google kimliğiyle test içinde
üretilir. Tüm parolalar çalıştırma başına rastgeledir; Docker kurulu bir
geliştirme makinesinde de çalışır ve yalnız kendi container/süreçlerini kapatır.

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
- HTTP ve Socket.IO hız sınırları istemci adresini aynı kuralla bulur:
  Express `trust proxy` hop sayısı kadar `X-Forwarded-For` sağdan atlanır.
  `RITIM_TRUST_PROXY=0` iken bu başlık ve `CF-Connecting-IP` yok sayılır.

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
