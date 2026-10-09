# Ritim — Türkçe

[Ana sayfa](../README.md) · [English](README.en.md) · [Son sürüm](../../releases/latest)

Ritim, kendi YouTube Music hesabını Windows’ta ayrı bir masaüstü penceresinde kullanmanı ve çalan müziği Android telefondan yönetmeni sağlar. PC tarafında resmi `music.youtube.com` sayfası çalışır. Android tarafı ekran görüntüsü veya video aktarmaz; PC’deki oturumdan alınan yapılandırılmış müzik bilgilerini yerel bir mobil arayüzde gösterir.

## Neler çalışıyor?

- YouTube Music ana sayfası, kişisel öneriler ve Google oturumu
- Keşfet, arama, kitaplık ve kategori filtreleri
- Sanatçı, albüm ve oynatma listesi detayları
- Oynat/duraklat, önceki/sonraki, sarma, ses, karıştırma ve tekrar
- Şimdi çalıyor ekranı ve tekilleştirilmiş sıradaki listesi
- Gerçek YouTube Music sırası üzerinde bundan sonra oynat, sıradan kaldır ve sırayı temizle
- Android bildirim ve kilit ekranından oynat/duraklat, önceki ve sonraki kontrolleri
- Komut onayı, gecikme ölçümü, yeniden bağlanma ve çevrimdışı içerik önbelleği bulunan Sync V2
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

Paketli Windows uygulaması GitHub Releases üzerinde yeni sürüm arar. **Ayarlar → Güncellemeler** ile denetleyebilir, indirmeyi başlatabilir ve hazır paketi **Yeniden başlat ve kur** ile kurabilirsin. Beta sürümleri Beta kanalını kullanır. Eski Alpha'dan Beta 1'e ilk geçiş bir kez elle kurulum gerektirir.

Android uygulaması uygun GitHub sürümünü denetler; indirmeyi sistem Download Manager üzerinden takip eder. APK kurulumu kullanıcı onayıyla başlar. Yayın APK'ları kalıcı Ritim sertifikası kullanır; farklı yerel debug sertifikasıyla kurulmuş geliştirme uygulaması bunun üzerine güncellenemez.

## Geliştirme

Gereksinimler: Node.js 24+, npm, Windows masaüstü paketi için Windows 10/11; Android derlemesi için JDK 21 ve Android SDK 36.

```powershell
npm ci
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
- PC, Sync V2’de oynatıcı durumunun tek yetkili kaynağıdır; telefon komutları benzersiz kimlikle gönderilir ve PC tarafından onaylanır.
- Music sayfasındaki köprü yalnızca görünür müzik meta verisini ve oynatıcı durumunu okur.
- React/Capacitor Android uygulaması yapılandırılmış veriyi yerel bileşenlerle gösterir ve Android MediaSession üzerinden sistem medya kontrollerini yayınlar.
- Sosyal özellikler HTTPS/WSS üzerinden Raspberry Pi gateway'ine bağlanır; aynı kişinin PC ve telefonu bir hesabın ayrı cihazlarıdır.
- GitHub Actions etiketli sürümlerde Windows kurucusunu, kanala göre `latest.yml`/`beta.yml`/`rc.yml` güncelleme bilgisini ve kalıcı sertifikalı Android APK'sını yayınlar.

## Sınırlar

YouTube Music’in sayfa yapısı Google tarafından değiştirildiğinde köprünün seçicileri güncellenmek zorunda kalabilir. Yerel Android derlemesi varsayılan debug imzasını, GitHub yayınları kalıcı Ritim sertifikasını kullanır; build variant adı tek başına imzayı belirlemez. Yerel PC–telefon kumandası aynı erişilebilir ağda çalışır; internet sosyal bağlantısı bu yerel kumandayı bir uzak ağ geçidine dönüştürmez.

Beta 1'in son fiziksel kabul turu kullanıcı kararıyla sonraki aşamaya ertelendi; Beta 2 devir incelemesindeki hataları düzeltir. [Beta 2 yayın notu](releases/v0.9.1-beta.2.md), [Beta 1 yayın notu](releases/v0.9.1-beta.1.md), [yol haritası](v0.9-roadmap.md) ve [Claude teslim notu](CLAUDE_HANDOFF.md) kapsamı ve bekleyen işleri açıklar.

Ritim bağımsız bir projedir; Google veya YouTube ile bağlantılı, onaylı ya da sponsorlu değildir.
