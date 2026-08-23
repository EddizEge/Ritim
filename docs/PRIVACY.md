# Ritim Gizlilik Bilgisi / Privacy Information

Son güncelleme / Last updated: 23 Ağustos 2026 / 23 August 2026

## Türkçe

Ritim bağımsız bir Windows ve Android uygulamasıdır. PC'deki resmi YouTube
Music oturumu oynatmanın yetkili kaynağıdır; ses telefona veya Ritim Social
sunucusuna aktarılmaz.

### PC ve telefon arasında

- Google parolan, tarayıcı çerezlerin ve YouTube Music oturumun PC'den çıkmaz.
- Telefon, yerel ağdaki PC'ye eşleme anahtarıyla bağlanır. Çalma durumu,
  katalog, sıra ve kumanda komutları bu yerel bağlantı üzerinden aktarılır.
- Eşleme anahtarı bir parola gibi ele alınır ve yalnız açık kullanıcı onayıyla
  gösterilir. Android'de işletim sisteminin güvenli saklama alanı kullanılır.

### Ritim Social

Sosyal özellikleri etkinleştirirsen Ritim Social; Google tarafından doğrulanan
hesap tanımlayıcısını, görünen ad ve avatarı, Ritim cihazlarını, gizlilik ve
bildirim tercihlerini, mesaj/tepki verilerini, oda üyeliğini, engelleme ve
şikâyet kayıtlarını saklayabilir. Google parolası, YouTube Music çerezleri ve
ses verisi sosyal sunucuya gönderilmez.

Çevrimiçi durum ve birlikte dinleme için gereken kısa ömürlü veriler Redis'te,
hesap ve sosyal kayıtlar PostgreSQL'de tutulur. Bağlı bir cihazı Ayarlar'dan
kaldırmak o cihazın sosyal oturumlarını iptal eder. Şikâyet ayrıntıları diğer
kullanıcılara gösterilmez; kullanıcı yalnız kendi gönderdiği şikâyetlerin
güvenli özetini görür.

### Dış hizmetler

- Google/YouTube: oturum açma ve resmi YouTube Music web deneyimi.
- Cloudflare: Ritim Social HTTPS/WSS uç noktasının güvenli iletimi.
- GitHub: uygulama güncellemeleri, sürüm notları ve kullanıcı geri bildirimi.

Ritim genel amaçlı reklam takibi veya üçüncü taraf reklam SDK'sı içermez. Bu
belge yeni veri akışları eklendiğinde güncellenir. Sorular ve veri talepleri
için projenin GitHub geri bildirim kanalını kullanabilirsin.

## English

Ritim is an independent Windows and Android application. The official YouTube
Music session on the PC remains the authoritative playback source; audio is
not relayed to the phone or to the Ritim Social server.

### Between the PC and phone

- Your Google password, browser cookies, and YouTube Music session do not
  leave the PC.
- The phone pairs with the PC on the local network using a pairing secret.
  Playback state, catalog, queue, and remote-control commands use that local
  connection.
- The pairing secret is treated like a password and is revealed only after
  explicit user consent. Android stores it using operating-system protected
  storage.

### Ritim Social

If you enable social features, Ritim Social may store the Google-verified
account identifier, display name and avatar, Ritim devices, privacy and
notification preferences, messages and reactions, room membership, blocks,
and reports. Your Google password, YouTube Music cookies, and audio are not
sent to the social server.

Short-lived presence and listening-room state use Redis; account and social
records use PostgreSQL. Removing a device in Settings revokes that device's
social sessions. Report details are not exposed to other users; a user sees
only a safe summary of reports they submitted.

### External services

- Google/YouTube: sign-in and the official YouTube Music web experience.
- Cloudflare: secure delivery of the Ritim Social HTTPS/WSS endpoint.
- GitHub: application updates, release notes, and user feedback.

Ritim does not include general-purpose advertising tracking or a third-party
advertising SDK. This notice will be updated when new data flows are added.
Use the project's GitHub feedback channel for questions or data requests.
