\set ON_ERROR_STOP on

-- Beta 1 Ayarlar yalnız kullanıcının gönderdiği şikâyetlerin güvenli özetini
-- okur. Açıklama, ileti bağlamı, iç moderasyon durumu ve dahili kimlikler bu
-- yetkiye dahil değildir.
revoke select on ritim.reports from ritim_app;

grant select (reporter_id, reported_user_id, reason, created_at)
  on ritim.reports to ritim_app;
