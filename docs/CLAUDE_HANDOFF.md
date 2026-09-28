# Ritim — Claude için ayrıntılı proje teslim notu

Belge tarihi: **28 Eylül 2026**. Geliştirici: **Ediz Ege Mercan**.
Depo: <https://github.com/EddizEge/Ritim>.
Beta 1 hedefi: <https://github.com/EddizEge/Ritim/releases/tag/v0.9.1-beta.1>.

Bu belge projenin mevcut durumunu ve geçmiş kararları devreder. Son kullanıcı
isteği Beta 1'i GitHub'da ön sürüm olarak yayınlamak ve projeyi Claude'a
teslim etmektir. Son fiziksel kabul turu şimdilik ertelenmiştir; testleri
tamamlanmış varsayma. Yayın işleminin kesin sonucu için GitHub Release ve
Actions durumunu kontrol et; belge yayın hazırlığı sırasında yazılmıştır.

## 1. İlk okunacaklar ve gerçek kaynaklar

1. Kök `AGENTS.md`: mimari kuralları, kritik davranışlar ve yayın süreci.
2. Bu belge: bağlam, geçmiş, dosya haritası ve sıradaki işler.
3. `docs/v0.9-roadmap.md`: ürün kapsamı ve sürüm hedefleri.
4. `docs/v0.9-beta1-implementation.md`: Beta 1 dilimleri ve kabul kayıtları.
5. `docs/releases/v0.9.1-beta.1.md`: iki dilli yayın notu ve test sınırları.
6. `deploy/pi/README.md`: canlı altyapı düzeni ve migration yöntemi.

Kanonik Windows deposu `C:\Users\Eddiz\Yt music App`'tir.
`C:\Users\Eddiz\Documents\Yt music App` başka bir çalışma deposu değil,
yönlendirme klasörüdür. Git, kod, build ve yayın işlemlerini kanonik depoda yap.
Başlarken `git status -sb`, aktif dal, `package.json` ve uzak yayınları denetle.
Bu not, güncel kod veya canlı sunucu ölçümü yerine geçmez.

## 2. Ürün fikri ve kullanıcının beklentisi

Ritim başlangıçta PC'deki YouTube Music'i telefondan yönetmek için geliştirildi.
Windows Electron uygulaması resmi `https://music.youtube.com` sitesini
kalıcı Google oturumuyla açar. Android uygulaması PC'den yapılandırılmış
veri alıp telefon için tasarlanmış arayüzü gösterir ve oynatıcı komutları verir.
Telefon ekran görüntüsü/video akışı almaz; içerik modelini yerel olarak render eder.

v0.9'un ana hedefi sosyal müzik ve arayüz iyileştirmeleridir: kullanıcıları
keşfetmek, ne dinlediklerini görmek, mesaj/tepki göndermek ve birlikte dinlemek.
İlk kullanıcı sayısı düşük olacağından görünürlük tercihlerine uyan ortak
kullanıcı dizini vardır. Genel feed veya takipçi sistemi hedeflenmemiştir.

**Tek kişi, tek sosyal hesap, birden çok cihaz** temel kuraldır. Kullanıcının
PC'si ve telefonu birbiriyle mesajlaşan iki ayrı kişi değildir. Başkalarının
hesaplarıyla mesajlaşır; kendi cihazları aynı hesabın durumunu senkronlar.
Telefonun cihaz kimliği ayrı, hesap kimliği ortaktır.

Ses her zaman katılımcının kendi PC'sindeki resmi YouTube Music oturumunda
çalmalıdır. Telefon ve Raspberry Pi ses taşımaz. Birlikte dinlemede her
katılımcının kendi PC'si ve kendi YouTube Music oturumu gerekir. PC kapalıyken
telefonun çevrimdışı içerik göstermesi bağımsız müzik oynatabileceği anlamına gelmez.

Kullanıcıyla Türkçe, samimi ve net iletişim kur. Geliştirici adı tam olarak
**Ediz Ege Mercan**; eski yanlış yazımlar kullanılmamalıdır.

## 3. Sürüm geçmişi

| Aşama | Yapılanlar | Durum/kaynak |
| --- | --- | --- |
| 0.7.x, Temmuz 2026 | Electron + Android temel ürün, QR, yerel oynatma kumandası, ilk GitHub paketleri, güncelleme/kurulum düzeltmeleri | Git geçmişi ve `docs/releases/v0.7*.md` |
| 0.8.0 | Mobil gezinme, içerik ve gerçek oynatma sırası işlemleri | `docs/releases/v0.8.0.md` |
| 0.8.1 | Çalarken arama ve player bar kaybı düzeltmeleri | `docs/releases/v0.8.1.md` |
| 0.8.2 | Discord Rich Presence | `docs/releases/v0.8.2.md` |
| 0.8.3 | Sync V2, komut/ack, gezinme ve sıra kararlılığı | `docs/releases/v0.8.3.md` |
| 0.8.4, 22 Temmuz | Sanatçı kartı, büyük arama sonucu ve doğru detay sayfasına geçiş | Son kararlı yayın; `docs/releases/v0.8.4.md` |
| Alpha 1, 23 Temmuz | Sosyal yüzey, kullanıcı dizini, hesap/cihaz ayrımı, yerel merkezi sosyal protokol | Kapsam donduruldu; ayrıca GitHub yayını yapılmış varsayma |
| Alpha 2, 25 Temmuz | Pi, PostgreSQL/Redis, OAuth/OIDC + PKCE, cihaz oturumları, Cloudflare | GitHub ön sürümü `v0.9.0-alpha.2` |
| Alpha 3, 28 Temmuz | Birebir mesajlar/istekler, bildirimler, engelleme/sessize alma/şikâyet, yeniden bağlanma | Sonraki Alpha 4 kapsamına dahil; ayrı tag varsayma |
| Alpha 4, 14 Ağustos | 8 kişilik odalar, oynatma zamanı/revision senkronu, sohbet/tepkiler, hata durumları | GitHub ön sürümü `v0.9.0-alpha.4` |
| Beta 1, Ağustos–Eylül | Hesap/cihaz, ayarlar, gizlilik/bildirim, görünüm, güvenli eşleme, updater ve Hakkında | Teknik sürüm `0.9.1-beta.1`; son fiziksel tur ertelenerek yayın kararı alındı |

Eski Alpha 2/4 etiketleri `0.9.0-alpha.*` olsa da iç uygulama sürümü `0.9.0`
olarak paketlenmişti. Bu tarihsel tutarsızlık Beta 1'de düzeltildi. Beta'nın
Windows/Android tarafından yeni sürüm kabul edilmesi için `0.9.1-beta.1`
seçildi; kararlı hedef `0.9.1`'dir. Kullanıcıya ürün ailesi v0.9 diye sunulur.

## 4. Beta 1 kapsamı ve yayın kararı

Dilim 1–5 geliştirmesi bitmiştir. Dilim 6'nın bazı gerçek cihaz/saha kabulü
beklemektedir. Kullanıcı 28 Eylül 2026'da son testin şimdilik yapılmamasını,
Beta 1'in GitHub'a eklenmesini ve Claude'a devir notu hazırlanmasını istedi.
Bu, ertelenen testlerin geçtiği veya kararlı sürümün hazır olduğu anlamına gelmez.

| Dilim | Sonuç |
| --- | --- |
| 1: sürüm ve güncelleme temeli | Semver, kanal seçimi, Android kodu, tag/paket CI doğrulaması |
| 2: hesap ve cihazlar | PC bölümlü Ayarlar, mobil Ayarlar; hesap/cihaz listesi ve iptal uçları; Pi dağıtımı |
| 3: sosyal/gizlilik/bildirim | Hesap tercihleri, moderasyon özetleri, yerel bildirim tercihleri; PostgreSQL izin migration'ı |
| 4: eşleme ve görünüm | Süreli QR/anahtar gösterimi, anahtar yenileme, oda senkron özeti, tema/yoğunluk/hareket/kapak |
| 5: updater ve Hakkında | Windows kontrollü kurulum, Android DownloadManager, ortak ürün bilgileri ve belgeler |
| 6: kabul ve kapanış | Eski Windows yükseltmesi geçti; son eşleme, çoklu fiziksel cihaz ve imzalı APK yükseltmesi ertelendi |

## 5. Sistem topolojisi

```text
Android Ritim (React + Capacitor)
  ├─ LAN / Socket.IO / eşleme tokenı → PC yerel Sync V2 :8787
  │                                      ↓ komut/ack/durum
  │                                Electron köprüsü
  │                                      ↓
  │                           resmi YouTube Music + PC sesi
  └─ HTTPS/WSS / Ritim access tokenı → Cloudflare Tunnel
                                           ↓
                                  Pi Social Gateway :8790
                                    ├─ PostgreSQL
                                    └─ Redis

Başka kullanıcıların PC/telefonları → aynı sosyal gateway
Her katılımcı PC → kendi YouTube Music sesi
```

Yerel kumanda ile sosyal servis farklı bağlantılardır. Sosyal gateway
kesilince yerel Sync V2 ve PC müziği çalışmaya devam etmelidir.
YouTube Music giriş oturumu ile Ritim Social OAuth oturumu da ayrıdır;
birinin çalışması diğerinin bağlı olduğunu kanıtlamaz.

## 6. Teknolojiler ve dosya haritası

Frontend React/TypeScript/Vite, masaüstü Electron/CommonJS, Android
Capacitor/Java, sosyal sunucu Node/TypeScript/Express/Socket.IO kullanır.
Kalıcı sosyal veri PostgreSQL 17, geçici veri Redis 7'dedir.
Node geliştirme/CI hedefi 24, mevcut Pi Dockerfile tabanı Node 22'dir.
Bağımlılıkların gerçek sürümleri `package-lock.json`'dadır; `latest`
yazan package aralıklarını yeniden çözmek için rastgele `npm update` çalıştırma.

| Yol | Görev |
| --- | --- |
| `electron/main.cjs` | Pencereler, resmi site view'ı, IPC, yerel sunucu, sosyal oturum, yaşam döngüsü |
| `electron/ytmusic-bridge.cjs` | Resmi DOM'dan görünür içerik/oynatıcı okuma ve gerçek oynatıcı komutları |
| `electron/youtube-service.cjs` | YouTube içerik/oturum hizmeti |
| `electron/sync-server.cjs` | Paketlenmiş PC'nin yerel Sync V2 sunucusu |
| `server/index.ts` | Geliştirme Sync V2 sunucusu; protokol değişirse Electron sürümüyle birlikte değerlendir |
| `electron/social-hub.cjs` | Paylaşılan sosyal olay/oda/moderasyon kuralları |
| `server/social.ts` | Sosyal HTTP/Socket.IO gateway ve sağlık uçları |
| `server/social-auth.ts` | Google token doğrulama, Ritim oturum/cihaz/ticket ve iptal |
| `server/social-store.ts` | PostgreSQL kayıtları, sosyal snapshot ve tercih kalıcılığı |
| `server/social-infrastructure.ts` | PostgreSQL/Redis bağlantısı ve hazırlık durumu |
| `server/social-security.ts` | Origin, proxy, bağlantı ve HTTP hız sınırları |
| `electron/social-auth-client.cjs` | PC PKCE OAuth, safeStorage ile Ritim oturum saklama |
| `src/social/auth.ts` | Web/Android sosyal kimlik ve yenileme/cihaz yardımcıları |
| `src/hooks/useSocial.ts`, `useSocialAccount.ts` | Sosyal bağlantı, olaylar ve hesap/cihaz görünümü |
| `src/hooks/usePlayerSync.ts` | Yerel komut, ack, authoritative durum, bağlantı/cache |
| `src/types.ts`, `src/social/types.ts` | Yerel müzik ve sosyal veri sözleşmeleri |
| `src/App.tsx` | Eşleme yaşam döngüsü, seri mutation kuyruğu ve platform görünümü |
| `src/components/MobileApp.tsx` | Mobil müzik/kumanda ve ana gezinme |
| `src/components/MobileSettings.tsx`, `SocialHub.tsx` | Mobil ayarlar ve ortak sosyal arayüz |
| `src/mobileConfig.ts`, `mobilePairingScanner.ts` | Güvenli eşleme depolaması, göç/sınıflandırma, QR |
| `electron/pairing-security.cjs` | PC token/installation kimliği, maskeli veri ve süreli gösterim |
| `electron/settings.*`, `shell.*` | PC ayarlar penceresi ve masaüstü kabuğu |
| `electron/room-playback-sync.cjs` | Oda saat farkı/gecikme ve kontrollü oynatma düzeltmesi |
| `electron/appearance-store.cjs`, `device-preferences.cjs` | PC'ye özel görünüm/bildirim tercihleri |
| `src/appearancePreferences.ts`, `appearanceContext.tsx` | Mobil/web görünüm tercihleri |
| `electron/updater.cjs`, `version-policy.cjs` | Windows kanal politikası ve kontrollü kurulum |
| `src/hooks/useMobileUpdate.ts`, `mobileUpdatePolicy.ts`, `versioning.ts` | Mobil kanal/sürüm seçimi ve indirme durumları |
| `android/app/src/main/java/app/ritim/mobile/` | MediaSession/service, güvenli depolama ve update eklentileri |
| `shared/product-info.json` | Geliştirici, ürün metni, bağımsızlık ve Hakkında bağlantıları |
| `public/sw.js` | Web/PWA cache fallback |
| `deploy/pi/` | Compose, Dockerfile, migration, backup ve systemd |
| `.github/workflows/` | CI, etiketli yayın ve eski kurtarma workflow'ları |

## 7. Korunması gereken müzik/kumanda davranışları

Resmi Google oturumu `persist:ritim-youtube-music` Electron partition'ında
kalır. Partition adını veya veri dizinini değiştirmek oturum kaybına yol açar.
Google çerezleri/parola/YouTube Music oturum tokenları telefona veya Pi'ye çıkmaz.

Arama SPA içinde `ytmusic-search-box.setQuery()` ve
`navigateToQueryResults()` ile yapılmalıdır. `webContents.loadURL()` ile
tam sayfa yenileme çalan müziği veya duraklatılmış player bar/queue DOM'unu
bozabilir. Yeni browse modeli hazır olana kadar eski sayfa verisini yayımlama.
Yalnız render edilmiş görünür sonuçları oku; gizli eski sonuçları karıştırma.

Geçici DOM boşluğunda son geçerli parça/katalog/sıra korunur. Queue video id,
başlık/sanatçı normalizasyonu ve ardışık tekrar kontrolüyle tekilleştirilir.
Sadece React state değiştirmek oynatıcı işlemi değildir: play/pause, next,
previous, seek, volume, shuffle, repeat ve sıra işlemleri gerçek resmi
oynatıcıya uygulanmalıdır. Player bar görünürlüğünü koruyan CSS önemlidir.

PC yerel oynatıcı durumunda yetkilidir. Telefon komutları benzersiz id,
issuedAt ve ack ile izlenir; `syncRevision` eski/out-of-order durumun yeniyi
ezmesini önler. Komut sahibi socket eşlemesi geciken yanıtı doğru telefona
iletir. Ses slider'ının optimistic değeri ack beklerken eski PC değeriyle
ezilmemelidir. PC yoksa komut başarısızlığı kullanıcıya bildirilir.

Mobilde sonsuz kaydırma, kart türüne göre doğru gezinme, üç nokta/uzun basma,
mini player, tam player ve Sıradaki/Şarkı Sözleri/Benzer korunmalıdır.
Şarkı değişince track id, queue ve Android medya bildirimi tutarlı olmalıdır.

## 8. Kimlik ve veri sahipliği

Sosyal kimlik Google OAuth/OIDC + PKCE ile doğrulanır. Sosyal sunucu izinli
client id/audience ve token doğrulamasını kullanır; istemcinin account/profile
iddiaları doğrulanmış socket kimliğini ezemez. PC Ritim access/refresh
oturumunu Electron safeStorage ile şifreler. Refresh token döndürülür,
hash'li saklanır; tekrar kullanım oturum ailesini iptal eder.

Telefon ayrıca Google giriş tokenı almaz. LAN eşleme anahtarıyla PC'den
tek kullanımlık companion ticket alır ve aynı Ritim hesabına kendi cihazı
olarak katılır. Token, installation id, hesap id ve device id birbirinin
yerine geçmez. Diğer cihaz iptali yalnız aynı hesaba ait hedefi etkiler.

| Veri/ayar | Sahibi ve konum |
| --- | --- |
| Google/YouTube Music oturumu | PC Electron partition |
| Ritim sosyal oturumu | PC safeStorage / Android güvenli depolama |
| Profil/dinleme görünürlüğü, mesaj/tepki tercihleri | Hesap / PostgreSQL |
| Bildirim sistem izni, görünüm | Bu cihaz / yerel depolama |
| PC–telefon eşleme sırrı | Cihaz çifti / güvenli yerel depolama |
| Mesajlar, cihazlar, şikâyetler, oda kayıtları | PostgreSQL |
| Presence, TTL'li sinyaller ve hız sınırları | Redis |

PostgreSQL `070_beta1_settings.sql`, uygulama rolünün tam reports okumasını
geri alır; yalnız güvenli özet sütunları açar. Şikâyet bağlamı ve iç moderasyon
bilgileri kullanıcıya sunulmaz. Engellenen/sessize alınan çevrimdışı kullanıcı
kayıtları snapshot'ta doğru kalmalıdır. Çıkış/PC değişimiyle yarışan geç
async token/device yazıları yeni oturumu kirletmemelidir.

## 9. Son gerçek telefon testinde bulunan eşleme sorunu

24 Ağustos'ta telefon eski PC adresi `172.16.20.63:8787`'yi kullanıyordu;
PC'nin o günkü adresi `192.168.1.51:8787` idi. Bunlar tarihsel test verisidir;
bugünkü IP'yi varsayma. Telefon eski linkte installation id bulunmadığından
token'dan türetilmiş kimliği saklamıştı. Yeni QR gerçek kalıcı PC kimliği
taşıyınca uygulama bunu farklı PC sanıp cache/oturum temizleme uyarısı gösterdi.
Uyarı iptal edildi; veri silinmedi.

Son üç düzeltme:

- `a8f1dde`: service worker ağ/cache kaçırmasında undefined yerine
  `Response.error()` döndürür; `Failed to convert value to Response` giderildi.
- `91263a1`: aynı PC IP/ad değişimi endpoint yenilemesidir; eski token/room
  değişimi ayrı onay ister; QR iptali/hatası mevcut eşlemeyi korur.
- `a9e619f`: aynı güçlü token + aynı room en güçlü devamlılık kanıtıdır;
  legacy türetilmiş kimlik gerçek installation id'ye veri silmeden taşınır.
  Aynı gerçek kimlikte token/oda değişimi reauthorization; hem kimlik hem
  güvenlik bağlamı farklıysa PC switch davranışı sürer.

Eşleme mutation'ları kuyrukta seri çalışır; token ve açık metadata farklı
QR işlemlerinden karışmamalıdır. Native record şifrelidir, açık metadata
ham token içermez. Güvenli yazma başarısızsa başarılı eşleme gösterilmez.
Anahtar yenileme eski telefonları düşürür. Anahtar gösterimi yalnız PC
Ayarlar penceresinde açık onayla 60 saniyelik, pencereye bağlı oturumdadır.
Token'ı loga, issue'ya, dokümana, ekran görüntüsüne veya teslim mesajına dökme.

Android deep-link: `ritim://connect?url=<URL-encoded-PC-link>`.
Ham HTTP link yerine bu scheme kullanılır; `AndroidManifest.xml` intent
filter'ı `connect` host'unu dinler. QR da aynı parser'a gider.

## 10. Birlikte dinleme modeli

Odalar sahibi dahil en fazla 8 hesaptır. Oda sahibi/üyelik, engelleme,
görünürlük, rol ve yetki kontrolleri sunucuda uygulanır. Oda playback modeli
video id, sunucu zamanı, pozisyon, oynatma/duraklatma durumu ve revision
taşır. PC gecikme/saat farkını ölçer ve gerektiğinde kontrollü seek yapar;
küçük sapmada müziğe müdahale edilmez.

Ev sahibi ayrıldı/PC kapalı, parça kullanılamıyor ve ağ değişti durumları
ayrı ele alınır. Oda sohbeti ve tepkiler vardır; bu sosyal sinyaller ses
relay değildir. Sanal çoklu PC/protokol testleri yapılmıştır, iki fiziksel
PC'nin gerçek ses/zaman uyumu son saha turunda hâlâ doğrulanmalıdır.

## 11. Raspberry Pi ve Cloudflare

Kullanıcıda Raspberry Pi 5 **16 GB RAM**, 128 GB SSD ve harici elektrikli
disk kutusunda 4 TB + 2 TB diskler vardır. CasaOS/cloudflared mevcuttur.
Belgelenmiş servis kökü `/DATA/AppData/ritim-alpha2`; `alpha2` adı tarihsel
olduğu için sırf yeni sürüm adı uğruna taşıma. Aynı cihazda başka servisler,
çok sayıda port ve VPN bulunduğundan port/route çakışmalarına dikkat et.

Üretim sosyal adresi `https://social.edizegemercan.com.tr`.
Compose: `deploy/pi/compose.alpha2.yml`; gateway host loopback `8790`.
PostgreSQL `5432`, Redis `6379` yalnız dahili Docker ağında kalır.
Cloudflared ayrı CasaOS container'ında çalışır; belgelenmiş origin
`http://127.0.0.1:8790`'dır. Mevcut container network yapısını incelemeden
topolojiyi değiştirme. Gateway origin allowlist, proxy ve rate limit ile korunur.
Geliştirme bellek içi kimliksiz modunu internete açma; üretimde auth zorunludur.

`/health` proses/altyapı özeti, `/ready` gerçek hazırlık durumu sağlar.
23 Ağustos'ta Beta 1 kimlik/ayar uçları ve `070` migration'ı dağıtılmıştı.
Bu teslim işlemi Pi'yi yeniden başlatmaz veya güncel canlı sağlık ölçümü
yerine geçmiş kaydı sunmaz; bir sonraki sunucu çalışmasında yeniden kontrol et.

Migration sırası: `001_app_role.sh`, `010_schema.sql`, `020` sosyal kontroller,
`030` mesaj istekleri, `040` bildirimler, `050` oda üyeliği, `060` oda
etkileşimleri, `070` Beta ayar/şikâyet izinleri. Mevcut PostgreSQL volume
ilk kurulum migration'larını otomatik tekrar çalıştırmaz. Yedek al, gerekli
idempotent migration'ı mevcut veriyi koruyarak uygula; volume'u silerek
yeniden kurma. Sunucu değişikliği için önce kullanıcının mevcut yetkisini
değerlendir; yeni kapsamlı kurulum/topoloji değişikliğini varsayma.

Yedek betikleri `deploy/pi/backup/`, takvimler `deploy/pi/systemd/` altındadır.
PostgreSQL dump AES-256-CBC/PBKDF2 ile şifrelenir. Operasyon README'sindeki
somut düzen: 4 TB diskte günlük 14 gün, 2 TB diskte haftalık 180 gün;
restore smoke geçici DB'ye gerçekten yükler. Genel roadmap'teki 30 günlük
hedef, off-site kopya ve UPS canlı olarak doğrulanmış kurulum diye sunulmaz.
Backup passphrase ve disk mount yollarını çıktıya dökmeden sahipten/ortamdan
doğrula. Kullanıcı geçmişte VPN erişim sorunu yaşamıştır; nedenini kanıtsız
Ritim'e veya Pi reboot'una bağlama, ağı bağımsız teşhis et.

## 12. Geliştirme ve derleme

Gereksinimler: Node.js 24, npm, Windows build için Windows, Android için
JDK 21 ve SDK 36. Minimum Android SDK 24'tür. CI temiz kurulumda `npm ci`
kullanır. Kök `.env.example` ve `deploy/pi/.env.alpha2.example` örnektir;
gerçek `.env` dosyaları ve keystore depoya alınmaz.

```powershell
npm ci
npm run desktop          # Vite + local Social + Electron
npm run dev              # Web + development Sync + Social
npm run build
npm run build:social
npm run dist:win
npm run android:apk
```

`desktop` yerel gateway bekler. Üretim sosyal servisini kullanmak için
`RITIM_SOCIAL_URL` (Electron) ve `VITE_SOCIAL_URL` (web build) birlikte
değerlendirilir. `VITE_SYNC_URL` telefona sabit bir eski PC IP'si gömmemelidir.
Varsayılan geliştirme portları Vite `5173`, Sync `8787`, Social `8790`.
Başlatmadan önce portları ve sahip süreçleri kontrol et. Yalnız bu görevde
başlattığın geliştirme/test süreçlerini kapat.

Web çıktı `dist/`, Social `dist-social/`, Windows `release/`, Android
`android/app/build/outputs/apk/debug/app-debug.apk`. Bu çıktılar ignore'dur;
paketleri Git LFS veya normal Git içine eklemek yayın yöntemi değildir.

## 13. Sürüm, imza ve updater kuralları

- `package.json` + lock sürümü birlikte değişir; Gradle bunlardan üretir.
- Beta 1 `versionName=0.9.1-beta.1`, `versionCode=90141`.
- Formül: major×1.000.000 + minor×10.000 + patch×100 + stage.
- Alpha stage 1–39, Beta 41–79, RC 81–98, kararlı 99.
- Kararlı `0.9.1` kodu 90199'dur; önceki yayın Alpha kodu 900 idi.
- Windows app id `app.ritim.desktop`, Android `app.ritim.mobile`.
- Kalıcı Android SHA-256:
  `6a5b01605a4a767da6d21e199d805d8ea230c4da01dcc4335bd18891f36c4458`.
- Yerel debug SHA-256:
  `a4d2b60760945ea32222ba786101854565935d152acc75b4c45446ef154ac95f`.

GitHub yayın APK'sı tarihsel olarak debug build variant'ında üretilir,
fakat Actions'ta kalıcı Ritim keystore'uyla imzalanır. Variant adı ile
imzalama kimliği aynı şey değildir. Yerel debug APK'yı yayın APK'sı diye
yükleme. Yayın imzalı Alpha → Beta aynı imzayla yerinde güncellenebilir;
yerel debug kurulum → yayın APK'sı farklı imza nedeniyle yerinde kurulamaz.
Veri koruma çözümü olarak uninstall/clear-data önerme. Geçiş için önce mevcut
sertifikayı incele ve ayrı veri koruma planı oluştur; ihtiyaç yoksa ertele.

İlk Alpha → Beta geçiş bir kez elle paket kurulumu ister. Sonraki Beta
güncellemeleri `beta.yml`, kararlı `latest.yml`, RC `rc.yml` kullanır.
Windows updater denetleme/indirme/kurma adımlarını ayırır; kurucu başlatma
başarısızsa Ritim'i erken kapatmaz. `prepareForUpdate()` / `stopRuntime()`
Discord, köprü, sunucu, pencereler ve single-instance lock'u sırayla kapatır.
Android DownloadManager indirir; kurulum kullanıcı dokunuşuyla başlar ve
paket kimliği/kodu/sertifika native katmanda doğrulanır.

## 14. Test kanıtı ve erteleme listesi

28 Eylül 2026'da tüm `.test.cjs`/`.test.ts` dosyaları
`node --import tsx --test <dosyalar>` ile çalıştırıldı:
**108 toplam, 105 geçti, 3 atlandı, 0 hata**. Atlananlar canlı gateway auth
ve PostgreSQL yeniden başlatma/kalıcılık testleridir; gerekli test URL/token/
altyapı yapılandırması olmadan bilinçli skip vardır. Canlı yönetici politika
testi `.test.mjs` ayrıca opt-in'dir, bu yerel turda çalıştırılmadı.
Web ve sosyal üretim build'i, 18 Electron JS syntax kontrolü, Android sync,
`assembleDebug` ve `lintDebug` geçti. GitHub CI/yayın sonucu yayın sırasında
ayrıca doğrulanmalıdır; güncel Actions kaydı nihai kanıttır.

Önceki gerçek kabul kayıtları: eski Windows `0.9.0 → Beta1` installer
yükseltmesinde 2.185 dosya/331.967.082 bayt verisi korundu; oturum/hesap,
cihaz, Hakkında ve updater çalıştı. 24 Ağustos SM-S721B üzerinde debug
Beta1 yerinde kuruldu; ilk kurulum zamanı/veri dizini değişmedi. Kişisel
YouTube Music içeriği, sosyal hesap, cihaz refresh, About/güncelleme/tema ve
geçici odada sohbet/tepki/kapatma kontrol edildi. Test odası kapatıldı.
Service-worker hatası güncellemeden sonra görünmedi. Son legacy eşleme
düzeltmesinin gerçek bağlantı turu yarıda kaldı; geçmiş testleri bugünkü
canlı sunucu durumu veya bütün kabul kapılarının kapanışı sayma.

Bekleyenler:

1. Son Windows paketiyle veri koruyan yerinde yükseltme ve yeniden bağlantı.
2. Eski IP/legacy PC kimliğinin gerçek telefonda hesap/cache silmeden geçişi.
3. Aynı hesap altında PC/telefonun ayrı cihaz görünümü, hedef cihaz iptali.
4. Profil/dinleme görünürlüğü ve mesaj/tepki tercihinin PC–telefon canlı senkronu.
5. İki fiziksel PC/farklı YouTube Music hesabı ve en az iki telefonla gerçek
   oda ses/zaman uyumu; oynat/duraklat/seek/parça değişimi/ev sahibi ayrılması.
6. Ağ kaybı, token yenileme, Pi/gateway yeniden başlatma ve yeniden bağlanma.
7. Sosyal servis kapalıyken yerel Sync V2/müzik çalışması.
8. Kalıcı imzalı yayın APK'sının uygun imzalı gerçek kurulum üzerine yükseltmesi.
9. Kararlı sürüm öncesi yedekten geri yükleme provası ve küçük ekran son kabulü.

Kullanıcı son fiziksel turu ertelemiştir; tekrar tekrar telefon bağlama veya
aynı onayı isteme. Sonraki geliştirme aşamasında bu borcu açıkça koru.

## 15. Yayın prosedürü ve paketler

Standart sıra: çalışma dalı → commit/push → PR → CI → main merge → annotated
`v0.9.1-beta.1` tag → tag push → `Release` Actions → yayın varlıkları kontrolü.
Bu devir öncesi geliştirme dalı `agent/v0.9.1-beta1-settings`, son kaynak
commit'i `a9e619f` ve main'den 12 commit ilerideydi. Devir/yayın belgeleri
ve sertifika çıktı uyumluluğu buna ek commit olacaktır. Yayın sonrası
aktif dalı/commit'i Git'ten yeniden oku; bu belgeyi hardcoded branch state sayma.

Gerekli varlıklar:

- `Ritim-Setup-0.9.1-beta.1.exe`
- `Ritim-Setup-0.9.1-beta.1.exe.blockmap`
- `beta.yml`
- `Ritim-Android-v0.9.1-beta.1.apk`

Actions Node 24, Android JDK 21 kullanır. Windows job release'i açar,
Android job ardından APK'yı ekler; release sayfasının görünmesi tek başına
tüm yayın başarıldı demek değildir. Workflow tamamını bekle, indirilen APK'da
package/version/code/kalıcı SHA-256'yı doğrula, iki dilli notları yayın body'sine
uygula. Sertifika parser'ı `Signer:` ve `Signer #1` çıktı biçimlerini destekler.

Kalıcı keystore Actions secret adları `RITIM_ANDROID_KEYSTORE_BASE64`,
`RITIM_ANDROID_KEYSTORE_PASSWORD`, `RITIM_ANDROID_KEY_ALIAS`,
`RITIM_ANDROID_KEY_PASSWORD`'dür. Adlar dokümante edilir; değerleri hiçbir
teslim dosyasına koyma. Sırlar GitHub'dan okunarak dışarı taşınmamalıdır.

24 Ağustos yerel Windows setup SHA-256
`B9C45336E99D7F47050668C3119D2B75AD13D681C8E1A1686C6703D898463368`,
yerel debug APK SHA-256
`0E1322E0B6EA29BAC1D43C30189FC94B8ED695B6F06CECDBCAB551D4F3228D11` idi.
CI yeniden üretimi farklı hash verebilir; bunları yayın asset hash'i sanma.
Son denetimde kurulu PC aynı Beta sürüm numarasını gösterse de eski build'di;
yalnız görünen semver, son düzeltmelerin kurulduğunu kanıtlamaz.

## 16. Claude ile önerilen devam sırası

Önce mevcut Beta1 release/workflow sonucunu ve repo temizliğini doğrula.
Kullanıcıya açık test borcunu kısa anlat; ardından kullanıcının yeni talebine
göre ilerle. Son fiziksel tur ertelenmişken aynı testi yeniden yayın engeline
dönüştürme. Yeni düzeltmeler gerekirse yayımlanmış Beta1 tag'ini taşımak veya
asset'lerini sessiz değiştirmek yerine yeni sürüm planla.

Beta2 veya RC kapsamı henüz onaylanmış bir özellik listesi değildir.
Önerilen yön: saha kullanımından gelen hatalar, bağlantı/installer kararlılığı,
native bildirim ve erişilebilirlik/görsel toparlama; sonra kalan uçtan uca
kabulü kapatıp `0.9.1` kararlıya geçiş. Mevcut listeyi kullanıcıyla
netleştirmeden sesli sohbet, feed, ses relay veya farklı mimariye genişletme.

Teşhis için başlangıç haritası:

- Çalarken arama/player bar kaybı: `ytmusic-bridge.cjs` ve injected CSS.
- Telefon eski state/queue/ses değeri: `usePlayerSync.ts`, iki Sync sunucusu ve ack/revision.
- Eşleme oturum/cache kaybı: `mobileConfig.ts`, `App.tsx`, secure native depolama.
- Hesap bilgileri alınamadı: sosyal config/`/auth/config`, OAuth ve bağlı cihaz uçları.
- Sosyal state/oda yetkisi: `social-hub.cjs`, doğrulanmış socket identity ve store.
- Updater kapatma/kurucu sorunu: `updater.cjs`, `prepareForUpdate()`, `build/installer.nsh`.
- Android imza çakışması: önce APK/kurulu sertifika ve versionCode; uninstall yapma.
- Pi/VPN erişimi: port/bind/container network/route; Ritim kaynaklı olduğunu varsayma.

## 17. İletişim, yetki ve veri koruma

Kullanıcı oyun oynadığını söylerse pencere açma, focus/fare/klavye çalma.
Computer-use izni gerektiğinde mevcut kullanıcı talimatını esas al; Escape
ile durdurulursa o tur UI otomasyonunu durdur. Proje harici müziğe, VPN'ye,
CasaOS uygulamalarına veya başka süreçlere müdahale etme.

Kullanıcı kurulum ve Pi değişikliklerinde port/yer/kapasiteyi bilmek ister;
anlaşılmış kapsamda çalış, gereksiz onay döngüsü oluşturma. Yeni geniş
sunucu kurulumunu veya mevcut disk/servis silmeyi yetki var sayarak yapma.
Kirli worktree'de kullanıcı değişikliklerini koru. Hard reset, veri dizini
temizleme, Android uninstall/clear-data, Docker volume silme yok.

Bu belge gerçek `.env`, OAuth secret, pairing URL/token, Google çerezleri,
keystore veya kişisel mesaj içeriği içermez. Claude'a devretmek bunları
public GitHub'a yükleme yetkisi değildir. Kod deposu zaten public'tir;
lisans açıklaması `shared/product-info.json` içinde tüm hakları saklıdır.
Lisansı veya geliştirici atfını izinsiz değiştirme.
