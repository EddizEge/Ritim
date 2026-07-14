# Ritim — Türkçe

[Ana sayfa](../README.md) · [English](README.en.md) · [Son sürüm](../../releases/latest)

Ritim, kendi YouTube Music hesabını Windows’ta ayrı bir masaüstü penceresinde kullanmanı ve çalan müziği Android telefondan yönetmeni sağlar. PC tarafında resmi `music.youtube.com` sayfası çalışır. Android tarafı ekran görüntüsü veya video aktarmaz; PC’deki oturumdan alınan yapılandırılmış müzik bilgilerini yerel bir mobil arayüzde gösterir.

## Neler çalışıyor?

- YouTube Music ana sayfası, kişisel öneriler ve Google oturumu
- Keşfet, arama, kitaplık ve kategori filtreleri
- Sanatçı, albüm ve oynatma listesi detayları
- Oynat/duraklat, önceki/sonraki, sarma, ses, karıştırma ve tekrar
- Şimdi çalıyor ekranı ve tekilleştirilmiş sıradaki listesi
- Uygulama içinden QR kodla güvenli telefon eşleştirme
- Windows ve Android için GitHub sürüm denetimi
- Discord Rich Presence

Ses telefona aktarılmaz; telefon PC’deki oynatıcıyı kontrol eder. Google çerezleri, şifre ve oturum anahtarları telefona gönderilmez. Yerel bağlantı, uygulama oturumuna özel rastgele bir eşleştirme anahtarıyla korunur.

## Kurulum

1. [Releases](../../releases/latest) sayfasından Windows kurucusunu indir ve Ritim’i aç.
2. Masaüstü penceresinde YouTube Music hesabına giriş yap.
3. Aynı sürümdeki Android APK’yı telefona kur.
4. PC’de Ritim araç çubuğundan **Ayarlar**’ı aç.
5. Telefon ve PC aynı Wi‑Fi ağındayken Android uygulamasında **QR kodu tara** seçeneğine dokun ve ekrandaki kodu okut.

Windows Güvenlik Duvarı ilk bağlantıda Ritim’e yerel ağ izni sorabilir. Yalnızca güvendiğin özel ağlarda izin ver.

## Güncellemeler

Paketli Windows uygulaması açılışta GitHub Releases üzerinde yeni sürüm arar. **Ayarlar → Güncellemeleri kontrol et** ile elle denetleyebilirsin. Güncelleme indirildiğinde **Yeniden başlat ve kur** düğmesi görünür.

Android uygulaması da açılışta son GitHub sürümünü denetler. Yeni APK varsa indirme sayfasını açar; Android güvenlik modeli gereği kurulumu kullanıcı onaylar.

## Geliştirme

Gereksinimler: Node.js 24+, npm, Windows masaüstü paketi için Windows 10/11; Android derlemesi için JDK 21 ve Android SDK 36.

```powershell
npm install
npm run desktop
```

Üretim derlemeleri:

```powershell
npm run dist:win
npm run android:apk
```

Android debug APK’sı `android/app/build/outputs/apk/debug/app-debug.apk` altında oluşur.

## Mimari

```text
Android Ritim ── yerel ağ / Socket.IO ── Windows Ritim ── resmi YouTube Music
   arayüz + kontrol                      köprü + ses          Google oturumu
```

- Electron ana süreci resmi YouTube Music penceresini ve yerel senkron sunucusunu yönetir.
- Music sayfasındaki köprü yalnızca görünür müzik meta verisini ve oynatıcı durumunu okur.
- React/Capacitor Android uygulaması yapılandırılmış veriyi yerel bileşenlerle gösterir.
- GitHub Actions etiketli sürümlerde Windows kurucusunu, `latest.yml` güncelleme bilgisini ve test APK’sını yayınlar.

## Sınırlar

YouTube Music’in sayfa yapısı Google tarafından değiştirildiğinde köprünün seçicileri güncellenmek zorunda kalabilir. Android sürümü şu anda test için debug imzalı APK üretir; mağaza dağıtımı için ayrı bir üretim anahtarı gerekir. Cihazlar aynı yerel ağda olmalıdır.

Ritim bağımsız bir projedir; Google veya YouTube ile bağlantılı, onaylı ya da sponsorlu değildir.
