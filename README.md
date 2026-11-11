# TS3 Müzik Botu

TeamSpeak 3 sunucunda kanala YouTube'dan müzik çalan bot. Kanal sohbetine veya bota özel mesajla `!play …` yazarak kontrol edilir.

## Nasıl çalışır

TS3'te ses gönderebilmek için botun gerçek bir istemci olarak bağlanması gerekir (ServerQuery ses gönderemez). Bu yüzden bot, **resmi TeamSpeak 3 Linux istemcisini** Docker içinde ekransız çalıştırır:

```
!play …  ──► TS3 istemcisi ──ClientQuery (127.0.0.1:25639)──► Node.js kontrolcü
                  ▲                                                  │
                  │ mikrofon = tsbot.monitor                         │ yt-dlp | ffmpeg
                  └──────────── PulseAudio "tsbot" sink ◄────────────┘
```

- **Xvfb** sanal ekran, **PulseAudio** sanal ses kartı sağlar.
- **yt-dlp** sesi YouTube'dan çeker, **ffmpeg** (ses normalizasyonu ile) `tsbot` sink'ine çalar. İstemci bu sink'in monitörünü mikrofon olarak kullanır.
- Kontrolcü (`src/`) istemcinin **ClientQuery** eklentisi üzerinden sohbet mesajlarını dinler, cevap verir; sadece müzik çalarken yayın yapar.
- İlk açılışta istemcinin lisans/tanıtım pencereleri `settings.db`'ye yazılarak atlanır, ses ayarları (PulseAudio + sürekli yayın) otomatik yapılır.
- İstemci çökerse veya sunucu bağlantısı koparsa bot kendini otomatik toparlar.

Harici npm bağımlılığı yoktur.

## Kurulum

Gereksinimler: Docker + Docker Compose, **x86_64 (amd64) Linux sunucu**. Resmi TS3 istemcisi sadece x86_64 için var. ARM'da (Apple Silicon, Raspberry Pi) emülasyonla çalışır ama yavaş ve önerilmez.

```bash
cp .env.example .env
# .env içinde en azından TS3_HOST'u doldur
docker compose up -d --build
docker compose logs -f
```

Logda `connected to server` görünce bot kanaldadır.

### TS3 sunucu tarafı (önemli)

- **Kanal codec'i:** Botun kanalını *Opus Music* ve kalite **10** yap (Kanalı düzenle → Ses). *Opus Voice* müziği kötü sıkıştırır.
- **Talk power:** Kanalda talk power gerekiyorsa bota yeterli yetki ver.
- **Anti-flood:** Bot uzun listelerde birkaç mesaj üst üste gönderebilir. Sorun çıkarsa botun kimliğini (UID) anti-flood muaf bir gruba ekle.
- Bot sadece **bulunduğu kanalın** sohbetini ve **kendisine gelen özel mesajları** duyar. Özel mesajda `!` öneki gerekmez.

TS3 sunucusu aynı makinede Docker *dışında* çalışıyorsa `TS3_HOST=host.docker.internal` yap ve `docker-compose.yml` içindeki `extra_hosts` satırlarının yorumunu kaldır.

## Komutlar

| Komut | Kısaltmalar | Açıklama |
|---|---|---|
| `!play <link \| arama>` | `!p`, `!çal` | Çalar ya da kuyruğa ekler. YouTube linki, oynatma listesi veya arama metni |
| `!playnext <link \| arama>` | `!pn`, `!sıradaki` | Kuyruğun başına ekler |
| `!search <arama>` | `!ara` | 5 sonuç listeler |
| `!pick <n>` | `!seç` | Arama sonucundan seçer |
| `!skip` | `!s`, `!geç` | Sonraki şarkı |
| `!pause` / `!resume` | `!duraklat` / `!devam` | Duraklat / devam |
| `!stop` | `!dur` | Durdurur, kuyruğu temizler |
| `!np` | `!şimdi` | Çalan şarkı ve süre |
| `!queue` | `!q`, `!liste` | Kuyruk |
| `!remove <n>` | `!sil` | Kuyruktan siler |
| `!clear` | `!temizle` | Kuyruğu temizler |
| `!shuffle` | `!karıştır` | Kuyruğu karıştırır |
| `!loop [off\|one\|all]` | `!tekrar` | Tekrar modu: kapalı / şarkı / liste |
| `!vol [0-100]` | `!ses` | Ses seviyesi |
| `!join` | `!gel` | Botu senin kanalına çeker |
| `!help` | `!yardım` | Komut listesi |

Kısaltmalardaki Türkçe karakterli komutların ASCII yazımı da çalışır: `!cal`, `!gec`, `!sec`, `!simdi`, `!karistir`, `!yardim`…

## Ayarlar (`.env`)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `TS3_HOST` | *(zorunlu)* | Sunucu adresi (`host` veya `host:port`) |
| `TS3_PORT` | `9987` | Ses portu |
| `TS3_SERVER_PASSWORD` | | Sunucu şifresi |
| `TS3_CHANNEL` | | Girilecek kanal (`Oyun/Müzik` gibi yol da olur). Boşsa varsayılan kanal |
| `TS3_CHANNEL_PASSWORD` | | Kanal şifresi |
| `BOT_NICKNAME` | `MusicBot` | Bot adı |
| `COMMAND_PREFIX` | `!` | Komut öneki |
| `ALLOWED_UIDS` | | Virgülle ayrılmış TS3 UID listesi. Boşsa herkes kullanabilir |
| `ANNOUNCE_TRACKS` | `true` | "▶ Çalıyor" mesajları |
| `DEFAULT_VOLUME` | `70` | Başlangıç sesi (0–100) |
| `NORMALIZE_AUDIO` | `true` | Şarkılar arası ses farkını eşitler (loudnorm) |
| `MAX_QUEUE` | `100` | Kuyruk sınırı |
| `MAX_PLAYLIST_ITEMS` | `50` | Bir oynatma listesinden en fazla kaç şarkı eklenir |
| `MAX_TRACK_DURATION` | `0` | Saniye cinsinden şarkı süresi sınırı. `0` sınırsız |
| `YTDLP_AUTO_UPDATE` | `true` | Container her açıldığında yt-dlp'yi günceller |
| `YTDLP_COOKIES_FILE` | | YouTube cookie dosyası (aşağıya bak) |
| `LOG_LEVEL` | `info` | `debug` ile ClientQuery trafiği de loglanır |

## Sık karşılaşılan durumlar

**"Sign in to confirm you're not a bot"**: YouTube sunucu IP'ni engelliyor olabilir. Tarayıcıdan bir YouTube cookie dosyası dışa aktar (Netscape formatı, `cookies.txt`). Dosyayı `./cookies/cookies.txt` olarak koy, `docker-compose.yml` içindeki volume satırını aç ve `.env`'e `YTDLP_COOKIES_FILE=/cookies/cookies.txt` ekle. Bunun için ana hesabını değil, ayrı bir hesap kullan.

**Bot sunucuya bağlanmıyor**: `docker compose logs -f` çıktısına bak. `LOG_LEVEL=debug` daha fazla ayrıntı verir. İstemcinin kendi logları volume içinde `~/.ts3client/logs/` altında:
`docker compose exec musicbot sh -c 'tail -50 $(ls -t ~/.ts3client/logs/*.log | head -1)'`

**Bot kimliği:** Kimlik `ts3client-data` volume'unda saklanır. Bu sayede bota verdiğin sunucu grupları yeniden başlatmalardan sonra da kalır. Volume'u silersen bot yeni bir kimlikle gelir.

**İlk açılış internet ister:** İstemci ClientQuery eklentisini ilk açılışta TeamSpeak'ten indirir.

**Kaynak kullanımı:** Bir bot yaklaşık 200–300 MB RAM kullanır. İmaj ~1.5 GB'tır.

**Lisans:** İmaj derlenirken TeamSpeak istemcisinin lisansı (EULA) otomatik kabul edilir. Botu kullanarak TeamSpeak lisans koşullarını kabul etmiş olursun.

## Geliştirme

```bash
npm test            # unit testler (protokol kaçışları, BBCode, mesaj bölme…)
```

Proje yapısı:

```
Dockerfile, docker-compose.yml, docker/entrypoint.sh   # Xvfb + PulseAudio + TS3 istemcisi + yt-dlp
src/index.js              # giriş noktası, sinyal yönetimi
src/bot.js                # bağlantı yönetimi, watchdog, mesaj → komut
src/commands.js           # sohbet komutları
src/player.js             # kuyruk ve yt-dlp | ffmpeg → PulseAudio
src/ytdlp.js              # link/arama/oynatma listesi çözümleme
src/ts3/client-process.js # TS3 istemcisini başlatma, settings.db hazırlama
src/ts3/clientquery.js    # ClientQuery (telnet) istemcisi
src/ts3/protocol.js       # TS3 query kaçış/ayrıştırma
```
