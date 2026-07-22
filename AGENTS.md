# Ritim Project Guide

Bu dosya Ritim üzerinde çalışan tüm ajanlar için kalıcı proje talimatıdır. Yeni bir sohbette işe başlamadan önce bu dosyanın tamamını oku ve burada yazan mimariyi koru.

## 1. Depo ve iletişim

- Kanonik depo yolu: `C:\Users\Eddiz\Yt music App`
- GitHub: `EddizEge/Ritim`
- `C:\Users\Eddiz\Documents\Yt music App` kanonik depo değildir; orada değişiklik yapma.
- Kullanıcıyla varsayılan olarak Türkçe ve samimi ama açık bir dille konuş.
- Her işe `git status -sb`, aktif dal, `package.json` sürümü ve ilgili dosyaları kontrol ederek başla.
- Önceki sürüm numarasını hafızadan varsayma. Kaynak gerçekliği `package.json`, Git etiketleri ve GitHub Releases'tır.
- Kullanıcının mevcut değişikliklerini koru; ilgisiz dosyaları stage etme, silme veya geri alma.

## 2. Ürün tanımı

Ritim iki parçalı bir YouTube Music deneyimidir:

1. Windows Electron uygulaması resmi `https://music.youtube.com` sitesini kalıcı Google oturumuyla bir `WebContentsView` içinde çalıştırır ve sesi PC'de çalar.
2. Android/telefon uygulaması PC'deki resmi YouTube Music oturumundan gelen ana sayfa, keşfet, arama, kitaplık, detay, sıra ve oynatma durumunu gösteren düşük gecikmeli bir kumandadır.

Temel ürün kuralları:

- Ses telefona, Bluetooth'a veya Ritim sunucusuna aktarılmaz; ses daima PC'deki YouTube Music tarafından çalınır.
- Google çerezleri, parola ve oturum bilgileri PC'den çıkmaz.
- Telefon kendi başına YouTube Music istemcisi gibi görünür fakat içerik ve oynatma yetkisi eşlenmiş PC oturumundan gelir.
- Ritim, Google/YouTube ile bağlı veya onlar tarafından onaylı bir ürün değildir.
- Resmi olmayan bir ses indirme, ses yeniden yayınlama veya DRM aşma sistemi ekleme.

## 3. Mimari

### Masaüstü

- Giriş noktası: `electron/main.cjs`
- YouTube Music köprüsü: `electron/ytmusic-bridge.cjs`
- Telefon için paketlenmiş senkron sunucusu: `electron/sync-server.cjs`
- Güncelleme yöneticisi: `electron/updater.cjs`
- Discord Rich Presence: `electron/discord-presence.cjs`
- Electron preload: `electron/preload.cjs`
- Masaüstü app id: `app.ritim.desktop`
- YouTube Music oturum partition'ını ve kalıcı Google oturum davranışını bozma.

### Mobil ve web arayüzü

- React uygulaması: `src/`
- Ana mobil görünüm: `src/components/MobileApp.tsx`
- Senkron istemcisi ve komutlar: `src/hooks/usePlayerSync.ts`
- Ortak tipler: `src/types.ts`
- Android kabuğu: `android/`
- Android application id: `app.ritim.mobile`
- Capacitor eşleme/QR akışı `src/mobileConfig.ts` ve Android native koduyla birlikte çalışır.

### Senkronizasyon

- Protokol Sync V2'dir; masaüstü authoritative kaynaktır.
- Varsayılan yerel port `8787`, varsayılan oda `EDIZ-4821`.
- Socket.IO olayları komut kimliği, ack, revision ve yeniden bağlanma durumunu korur.
- `syncRevision` eski/out-of-order telefon durumlarının yeni durumu ezmesini önler.
- Telefon komutu optimistic UI kullanabilir; PC'den gelen doğrulanmış durum sonunda authoritative olmalıdır.
- Eşleme token'ı yerel olarak oluşturulur. Token doğrulamasını kaldırma veya QR URL'sinden çıkarma.

## 4. Korunması gereken kritik davranışlar

### YouTube Music gezinmesi

- Arama sırasında `webContents.loadURL()` ile tam sayfa yenileme yapma.
- Arama `ytmusic-search-box.setQuery()` ve `navigateToQueryResults()` üzerinden SPA içinde yapılır.
- Tam sayfa yenileme çalarken iptal olabilir; duraklatılmışken player bar ve queue DOM'unu yok edebilir.
- Navigasyon sürerken eski browse durumunu yayınlama. Yeni sonuç modeli hazır olduktan sonra capture et.
- DOM'dan içerik toplarken yalnızca render edilen/görünür öğeleri kullan; gizli eski sayfa sonuçlarını yeni aramaya karıştırma.

### Oynatıcı ve sıra

- Geçici DOM boşluklarında son geçerli `trackId`, katalog ve queue korunmalıdır.
- Queue'da video id, normalize edilmiş başlık/sanatçı ve ardışık tekrar kontrolleri vardır; çift öğe hatasını geri getirme.
- YouTube Music player bar görünürlüğü `electron/main.cjs` içindeki enjekte CSS ile sabitlenir. Arama veya sayfa geçişi sırasında kaybolmamalıdır.
- Şarkı değişince PC ve telefon arayüzü aynı track id, sıra ve oynatma durumuna dönmelidir.
- Ses seviyesi komutlarında PC authoritative olsa da beklenen telefon değeri ack penceresi boyunca eski değerle geri ezilmemelidir.
- Önceki/sonraki, seek, shuffle, repeat, lyrics, related ve queue işlemlerini gerçek YouTube Music oynatıcısına uygula; sadece React state değiştirmek yeterli değildir.

### Mobil içerik

- Ana sayfa, keşfet, arama ve kitaplık aşağı kaydırıldığında daha fazla içerik yükleyebilmelidir.
- Şarkı/playlist üç nokta menüsü ve uzun basma davranışı korunmalıdır.
- Tam oynatıcıda Sıradaki, Şarkı Sözleri ve Benzer sekmeleri track id ile eşleşmelidir.
- PC geçici olarak erişilemezse güvenli cache gösterilebilir; cache yeni authoritative state'i ezmemelidir.

### Discord

- Discord Application ID: `1528122277500030976`
- Ortam değişkeni `RITIM_DISCORD_CLIENT_ID` verilirse varsayılanı override edebilir.
- Rich Presence asset anahtarı `ritim`dir.
- Şarkı, sanatçı, oynatma/duraklatma durumu ve geçen süre gösterilir.
- Discord Ritim'den sonra açılırsa yeniden bağlantı denenir; Discord kapalı diye uygulamayı çökertme.
- Asset hazır değilse presence'i görselsiz fallback ile yayınlamaya devam et.

## 5. Önemli dosyalar ve kimlikler

- Ana sürüm: `package.json` içindeki `version`
- Lock sürümü: `package-lock.json` içindeki kök ve ana paket sürümleri
- Android `versionName` ve `versionCode`: `android/app/build.gradle` tarafından `package.json` semver değerinden üretilir.
- Kod formülü: `major * 10000 + minor * 100 + patch`
- Windows paket ayarı: `electron-builder.config.cjs`
- Uygulama ikonu: `build/icon.png` (512x512), `build/icon.ico`, `build/icon.svg`
- Release workflow: `.github/workflows/release.yml`
- İki dilli release notları: `docs/releases/vX.Y.Z.md`
- Kalıcı Android yayın sertifikası SHA-256:
  `6a5b01605a4a767da6d21e199d805d8ea230c4da01dcc4335bd18891f36c4458`

Bu application id'leri, Android sertifikasını ve GitHub release dosya adlarını değiştirmek mevcut kullanıcıların güncellemesini kırar. Açık kullanıcı onayı olmadan değiştirme.

## 6. Geliştirme düzeni

1. Doğru repo kökünde ve temiz/iyi anlaşılmış worktree'de olduğunu doğrula.
2. Sorunu mümkünse gerçek imzalı YouTube Music oturumunda yeniden üret.
3. Kök nedeni belirle; geçici UI yamasıyla yetinme.
4. Değişikliği dar kapsamda uygula.
5. Syntax, TypeScript, build ve ilgili gerçek akışı doğrula.
6. Sürüm yayınlanacaksa semver'i yükselt, iki dilli release notu ekle, PR üzerinden main'e birleştir ve tag yayınla.

Dosya düzenlerken:

- Küçük ve anlaşılır patch'ler kullan.
- `electron/ytmusic-bridge.cjs` kırılgan bir resmi site adaptörüdür; seçicileri çok genişletmeden gerçek DOM verisiyle doğrula.
- React state ve hook bağımlılıklarında stale closure, duplicate listener ve gereksiz reconnect üretme.
- Sunucu protokolü değişirse hem `server/index.ts` hem `electron/sync-server.cjs` eşzamanlı güncellenmelidir.
- Ortak state şekli değişirse `src/types.ts`, cache okuma, sunucular ve native media session birlikte değerlendirilmelidir.

## 7. Doğrulama matrisi

Değişikliğe göre ilgili testleri çalıştır; bir release öncesinde mümkün olan tüm matrisi uygula.

### Temel kontroller

```powershell
node --check electron/main.cjs
node --check electron/ytmusic-bridge.cjs
node --check electron/discord-presence.cjs
npm run build
```

### Masaüstü gerçek akış

- Kalıcı Google oturumunun açıldığını doğrula.
- Bir şarkı oynat, duraklat, devam ettir, önceki/sonraki ve seek dene.
- Şarkı çalarken telefondan arama yap; ses devam etmeli, PC player bar görünmeli, telefon track ve queue'yu korumalı.
- Ana sayfa/keşfet/kitaplık/detay ve geri gezinmesini kontrol et.
- YouTube Music player bar için `display`, `opacity`, `transform` ve ölçüleri gerektiğinde DevTools/CDP ile doğrula.

### Mobil arayüz

- Browser tabanlı QA yaparken en az `384x832` mobil viewport kullan.
- Arama sonucu, mini player, tam player, 20 öğeye kadar sıra, lyrics/related ve menüleri kontrol et.
- Konsol error/warn kayıtlarını kontrol et.
- Android native bildirim ve kilit ekranı kontrollerini etkileyen değişikliklerde gerçek APK testi yap.

### Android

```powershell
npm run android:sync
cd android
.\gradlew.bat assembleDebug
```

- APK package id `app.ritim.mobile` olmalı.
- `versionName` package sürümüyle, `versionCode` formülle eşleşmeli.
- Yerel debug APK farklı debug sertifikası kullanabilir. Yayın kararı GitHub Actions'ın kalıcı sertifika doğrulamasına göre verilir.

### Windows

```powershell
npm run dist:win
```

- `release/latest.yml` sürümü doğru olmalı.
- Beklenen dosya `Ritim-Setup-X.Y.Z.exe` ve `.blockmap` olmalıdır.
- Installer/update testi öncesi geliştirme Electron sürecini ve yalnızca bu projeye ait 4173/8787/9222 test süreçlerini kapat.

## 8. Release süreci

- Patch düzeltmesi: `X.Y.Z+1`; büyük özellikler için minor sürümü değerlendir.
- `package.json` ve `package-lock.json` sürümlerini birlikte güncelle.
- `docs/releases/vX.Y.Z.md` dosyasında Türkçe ve İngilizce not yaz.
- Yalnızca ilgili dosyaları stage et.
- Standart akış: `agent/...` dalı -> commit -> push -> PR -> main'e merge -> annotated `vX.Y.Z` tag -> tag push.
- Tag push `.github/workflows/release.yml` workflow'unu tetikler.
- Workflow tamamen başarılı olmadan release'i tamamlanmış sayma.
- Release varlıkları şunları içermelidir:
  - `latest.yml`
  - `Ritim-Setup-X.Y.Z.exe`
  - `Ritim-Setup-X.Y.Z.exe.blockmap`
  - `Ritim-Android-vX.Y.Z.apk`
- GitHub'ın ürettiği notları iki dilli `docs/releases/vX.Y.Z.md` içeriğiyle güncelle.
- Yayın APK'sını indirip application id, versionName, versionCode ve kalıcı sertifika SHA-256 değerini doğrula.
- Sonunda `main...origin/main` temiz olmalı ve geliştirme süreçleri kapatılmalıdır.

## 9. Güncelleyici ve süreç güvenliği

- Ritim güncellemesi sırasında installer'ın "Ritim kapatılamaz" hatasına dönmemesi kritik bir gereksinimdir.
- `prepareForUpdate()` ve `stopRuntime()` Discord, YouTube köprüsü, yerel sunucu, pencereler ve single-instance lock'u kontrollü kapatır; bu sırayı bozma.
- `git reset --hard`, kullanıcı dosyalarını silme veya ilgisiz süreçleri kapatma.
- Port kapatırken yalnızca bu testte başlatılan PID'leri hedefle.
- Kullanıcı oyun oynadığını veya ekranda pencere istemediğini söylerse computer-use, görünür pencere ve odak çalan işlemler kullanma.
- Opera'da veya başka uygulamalarda çalan müziğe dokunma. Test gerekiyorsa yalnızca Ritim Electron oturumunu kullan.

## 10. Gelecek özellik sınırları

- Arkadaşlarla ortak dinleme yapılırsa ses relay edilmez. Her katılımcının kendi PC'si ve kendi YouTube Music oturumu aynı video id/zaman damgasına senkronlanır.
- İnternet üzerinden oda/davet özelliği; kimlik doğrulama, oda yetkisi, gecikme düzeltmesi, gizlilik ve abuse koruması olmadan yayınlanmamalıdır.
- Discord Join/party secrets ancak güvenli bir genel relay ve oda modeli hazırlandıktan sonra eklenmelidir.
- Büyük mimari değişiklikleri hotfix sürümüne sıkıştırma; ayrı minor sürüm ve test planı kullan.

## 11. İş teslimi

Son cevapta kısa biçimde şunları bildir:

- Ne düzeltildi/eklendi.
- Kök neden veya önemli tasarım kararı.
- Hangi testlerin gerçekten geçtiği.
- Commit/PR/release bağlantıları (yayın yapıldıysa).
- Kullanıcının yapması gereken tek bir sonraki adım varsa onu.

Yapılmamış testi yapılmış gibi, devam eden workflow'u başarılı gibi veya yerel debug APK'yı yayın imzalı gibi sunma.
