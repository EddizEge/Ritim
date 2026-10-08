\set ON_ERROR_STOP on

-- Beta 2: mesaj isteği reddedilince konuşmanın mesajları yumuşak silinir
-- (deleted_at) ve mesaja tepki eklenirken mesaj satırı FOR UPDATE ile
-- kilitlenir. İkisi de ritim.messages üzerinde UPDATE yetkisi ister; 010'dan
-- beri uygulama rolünde yalnız SELECT ve INSERT vardı, bu yüzden iki akış da
-- "permission denied" ile başarısız oluyordu. Yalnız yumuşak silme sütunu
-- açılır; mesaj gövdesi ve kimlik sütunları değiştirilemez kalır.
-- Betik idempotenttir.
grant update (deleted_at) on ritim.messages to ritim_app;
