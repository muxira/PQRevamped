#!/usr/bin/env python3
"""Keep the 18 lang.json dictionaries complete.

Upstream ships a dictionary per language and this fork adds a handful of keys of
its own. Rather than hand-editing 18 files, run this script:

    python3 scripts/sync-i18n.py                    # audit only
    python3 scripts/sync-i18n.py --scrape           # audit + read the English values
                                                    # straight from partyquiz.club

`--scrape` fills in any key that exists upstream but is missing here, so a new
upstream feature keeps its English wording before a translator touches it.
Every language is then topped up with English for keys it still lacks, which is
exactly what i18n.js already does at runtime — doing it on disk keeps the files
diffable and makes a missing translation visible in review.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALIZED = ROOT / "localized"
UPSTREAM = "https://partyquiz.club/localized/english/lang.json"

# Keys this fork introduces. English text lives here so a scrape is not required.
REVAMPED_KEYS = {
    "settings": "Settings",
    "more": "More",
    "share_game": "Share game link",
    "install_app": "Install app",
    "link_copied": "Link copied",
    "language": "Language",
    "appearance": "Appearance",
    "theme_auto": "Auto",
    "theme_studio": "Light",
    "theme_night": "Dark",
    "haptics": "Haptic feedback",
    "keep_awake": "Keep screen awake",
    "ca_tab_flat": "2D",
    "ca_tab_3d": "3D",
    "ca_loading": "Loading 3D…",
    "ca_hint_orbit": "Drag to orbit",
    "ca_hint_pinch": "Pinch to zoom",
    "ca_reset_view": "Reset view",
    "ca_unavailable": "3D preview is not available in this browser.",
    "ca_library_failed": "Could not load the 3D engine. Reload the page to try again.",
    "ca_mask_failed": "Silhouette unavailable",
    "ca_model_failed": "Body model unavailable — showing a placeholder.",
    "ca_texture_failed": "Could not load that image for the 3D preview.",
    "ca_context_lost": "The 3D preview stopped. Reopen the avatar editor to try again.",
    "leave_confirm_text": "Leave the game? If a round is running it will count as a pass.",
    "cancel": "Cancel",
    "close": "Close",
    "refresh": "Refresh",
    "resume_retry_note": "The server did not answer. If the game is still running, try again in a moment.",
}

# Short, hand-written translations for the strings the settings sheet shows.
TRANSLATIONS = {
    "ca_mask_failed": {
        "english": "Silhouette unavailable",
        "russian": "Силуэт недоступен",
        "ukrainian": "Силует недоступний",
        "german": "Silhouette nicht verfügbar",
        "french": "Silhouette indisponible",
        "spanish": "Silueta no disponible",
        "spanishlatinamerica": "Silueta no disponible",
        "portuguese": "Silhueta indisponível",
        "polish": "Sylwetka niedostępna",
        "italian": "Silhouette non disponibile",
        "turkish": "Silüet kullanılamıyor",
        "czech": "Silueta není k dispozici",
        "swedish": "Silhuetten är inte tillgänglig",
        "kazakh": "Сұлба қолжетімсіз",
        "simplifiedchinese": "剪影不可用",
        "japanese": "シルエットを利用できません",
        "korean": "실루엣을 사용할 수 없습니다",
        "arabic": "الصورة الظلية غير متاحة",
    },
    "resume_server_unreachable": {
        "english": "Game found, but the server is not answering. You can try to reconnect or leave the game.",
        "russian": "Игра найдена, но сервер не отвечает. Можно попробовать подключиться снова или выйти из игры.",
        "ukrainian": "Гру знайдено, але сервер не відповідає. Можна спробувати підключитися знову або вийти з гри.",
        "german": "Spiel gefunden, aber der Server antwortet nicht. Du kannst die Verbindung erneut versuchen oder das Spiel verlassen.",
        "french": "Partie trouvée, mais le serveur ne répond pas. Vous pouvez réessayer de vous connecter ou quitter la partie.",
        "spanish": "Partida encontrada, pero el servidor no responde. Puedes intentar reconectarte o salir de la partida.",
        "spanishlatinamerica": "Partida encontrada, pero el servidor no responde. Puedes intentar reconectarte o salir de la partida.",
        "portuguese": "Partida encontrada, mas o servidor não responde. Pode tentar reconectar-se ou sair da partida.",
        "polish": "Znaleziono grę, ale serwer nie odpowiada. Możesz spróbować połączyć się ponownie albo opuścić grę.",
        "italian": "Partita trovata, ma il server non risponde. Puoi provare a riconetterti o uscire dalla partita.",
        "turkish": "Oyun bulundu ama sunucu yanıt vermiyor. Yeniden bağlanmayı deneyebilir veya oyundan çıkabilirsiniz.",
        "czech": "Hra nalezena, ale server neodpovídá. Můžete to zkusit znovu, nebo hru opustit.",
        "swedish": "Matchen hittades, men servern svarar inte. Du kan försöka ansluta igen eller lämna matchen.",
        "kazakh": "Ойын табылды, бірақ сервер жауап бермейді. Қайта қосылып көруге немесе ойыннан шығуға болады.",
        "simplifiedchinese": "已找到对局，但服务器没有响应。你可以重试连接或退出游戏。",
        "japanese": "ゲームは見つかりましたが、サーバーが応答していません。再接続するか、ゲームを退出できます。",
        "korean": "게임을 찾았지만 서버가 응답하지 않습니다. 다시 연결하거나 게임에서 나갈 수 있습니다.",
        "arabic": "تم العثور على اللعبة، لكن الخادم لا يستجيب. يمكنك إعادة محاولة الاتصال أو مغادرة اللعبة.",
    },
    "resume_retry_note": {
        "russian": "Сервер не ответил. Если игра ещё идёт, попробуйте ещё раз через минуту.",
        "ukrainian": "Сервер не відповів. Якщо гра ще триває, спробуйте ще раз за хвилину.",
        "german": "Der Server hat nicht geantwortet. Läuft die Partie noch, versuche es gleich noch einmal.",
        "french": "Le serveur n'a pas répondu. Si la partie continue, réessayez dans un instant.",
        "spanish": "El servidor no respondió. Si la partida sigue en marcha, inténtalo de nuevo en un momento.",
        "spanishlatinamerica": "El servidor no respondió. Si la partida sigue en marcha, inténtalo de nuevo en un momento.",
        "portuguese": "O servidor não respondeu. Se a partida ainda está a decorrer, tente novamente daqui a pouco.",
        "polish": "Serwer nie odpowiedział. Jeśli gra wciąż trwa, spróbuj ponownie za chwilę.",
        "italian": "Il server non ha risposto. Se la partita è ancora in corso, riprova tra poco.",
        "turkish": "Sunucu yanıt vermedi. Oyun hâlâ sürüyorsa birazdan tekrar deneyin.",
        "czech": "Server neodpověděl. Pokud hra stále běží, zkuste to za chvíli znovu.",
        "swedish": "Servern svarade inte. Om matchen fortfarande pågår kan du försöka igen om en stund.",
        "kazakh": "Сервер жауап бермеді. Ойын әлі жалғасып жатса, сәлден кейін қайталап көріңіз.",
        "simplifiedchinese": "服务器没有响应。如果对局仍在进行，请稍后再试。",
        "japanese": "サーバーから応答がありません。ゲームが続いている場合は、しばらくしてからもう一度お試しください。",
        "korean": "서버가 응답하지 않습니다. 게임이 계속 진행 중이라면 잠시 후 다시 시도해 주세요.",
        "arabic": "لم يستجب الخادم. إذا كانت اللعبة مستمرة، فحاول مرة أخرى بعد قليل.",
    },
    "settings": {
        "russian": "Настройки", "ukrainian": "Налаштування", "german": "Einstellungen",
        "french": "Paramètres", "spanish": "Ajustes", "spanishlatinamerica": "Ajustes",
        "portuguese": "Configurações", "polish": "Ustawienia", "italian": "Impostazioni",
        "turkish": "Ayarlar", "czech": "Nastavení", "swedish": "Inställningar",
        "kazakh": "Параметрлер", "simplifiedchinese": "设置", "japanese": "設定",
        "korean": "설정", "arabic": "الإعدادات",
    },
    "language": {
        "russian": "Язык", "ukrainian": "Мова", "german": "Sprache", "french": "Langue",
        "spanish": "Idioma", "spanishlatinamerica": "Idioma", "portuguese": "Idioma",
        "polish": "Język", "italian": "Lingua", "turkish": "Dil", "czech": "Jazyk",
        "swedish": "Språk", "kazakh": "Тіл", "simplifiedchinese": "语言",
        "japanese": "言語", "korean": "언어", "arabic": "اللغة",
    },
    "appearance": {
        "russian": "Оформление", "ukrainian": "Оформлення", "german": "Darstellung",
        "french": "Apparence", "spanish": "Apariencia", "spanishlatinamerica": "Apariencia",
        "portuguese": "Aparência", "polish": "Wygląd", "italian": "Aspetto",
        "turkish": "Görünüm", "czech": "Vzhled", "swedish": "Utseende",
        "kazakh": "Көрініс", "simplifiedchinese": "外观", "japanese": "外観",
        "korean": "테마", "arabic": "المظهر",
    },
    "theme_auto": {
        "russian": "Авто", "ukrainian": "Авто", "german": "Auto", "french": "Auto",
        "spanish": "Auto", "spanishlatinamerica": "Auto", "portuguese": "Auto",
        "polish": "Auto", "italian": "Auto", "turkish": "Oto", "czech": "Auto",
        "swedish": "Auto", "kazakh": "Авто", "simplifiedchinese": "自动",
        "japanese": "自動", "korean": "자동", "arabic": "تلقائي",
    },
    "theme_studio": {
        "russian": "Светлая", "ukrainian": "Світла", "german": "Hell", "french": "Clair",
        "spanish": "Claro", "spanishlatinamerica": "Claro", "portuguese": "Claro",
        "polish": "Jasny", "italian": "Chiaro", "turkish": "Açık", "czech": "Světlý",
        "swedish": "Ljust", "kazakh": "Ашық", "simplifiedchinese": "浅色",
        "japanese": "ライト", "korean": "라이트", "arabic": "فاتح",
    },
    "theme_night": {
        "russian": "Тёмная", "ukrainian": "Темна", "german": "Dunkel", "french": "Sombre",
        "spanish": "Oscuro", "spanishlatinamerica": "Oscuro", "portuguese": "Escuro",
        "polish": "Ciemny", "italian": "Scuro", "turkish": "Koyu", "czech": "Tmavý",
        "swedish": "Mörkt", "kazakh": "Қараңғы", "simplifiedchinese": "深色",
        "japanese": "ダーク", "korean": "다크", "arabic": "داكن",
    },
    "more": {
        "russian": "Ещё", "ukrainian": "Ще", "german": "Mehr", "french": "Plus",
        "spanish": "Más", "spanishlatinamerica": "Más", "portuguese": "Mais",
        "polish": "Więcej", "italian": "Altro", "turkish": "Daha fazla",
        "czech": "Další", "swedish": "Mer", "kazakh": "Қосымша",
        "simplifiedchinese": "更多", "japanese": "その他", "korean": "더보기",
        "arabic": "المزيد",
    },
    "share_game": {
        "russian": "Поделиться ссылкой", "ukrainian": "Поділитися посиланням",
        "german": "Spiellink teilen", "french": "Partager le lien",
        "spanish": "Compartir enlace", "spanishlatinamerica": "Compartir enlace",
        "portuguese": "Compartilhar link", "polish": "Udostępnij link",
        "italian": "Condividi link", "turkish": "Oyun bağlantısını paylaş",
        "czech": "Sdílet odkaz", "swedish": "Dela spellänk",
        "kazakh": "Сілтемені бөлісу", "simplifiedchinese": "分享游戏链接",
        "japanese": "ゲームリンクを共有", "korean": "게임 링크 공유",
        "arabic": "مشاركة رابط اللعبة",
    },
    "install_app": {
        "russian": "Установить приложение", "ukrainian": "Встановити застосунок",
        "german": "App installieren", "french": "Installer l'appli",
        "spanish": "Instalar la app", "spanishlatinamerica": "Instalar la app",
        "portuguese": "Instalar app", "polish": "Zainstaluj aplikację",
        "italian": "Installa l'app", "turkish": "Uygulamayı yükle",
        "czech": "Nainstalovat aplikaci", "swedish": "Installera appen",
        "kazakh": "Қолданбаны орнату", "simplifiedchinese": "安装应用",
        "japanese": "アプリをインストール", "korean": "앱 설치",
        "arabic": "تثبيت التطبيق",
    },
    "link_copied": {
        "russian": "Ссылка скопирована", "ukrainian": "Посилання скопійовано",
        "german": "Link kopiert", "french": "Lien copié",
        "spanish": "Enlace copiado", "spanishlatinamerica": "Enlace copiado",
        "portuguese": "Link copiado", "polish": "Link skopiowany",
        "italian": "Link copiato", "turkish": "Bağlantı kopyalandı",
        "czech": "Odkaz zkopírován", "swedish": "Länk kopierad",
        "kazakh": "Сілтеме көшірілді", "simplifiedchinese": "链接已复制",
        "japanese": "リンクをコピーしました", "korean": "링크가 복사되었습니다",
        "arabic": "تم نسخ الرابط",
    },
    "haptics": {
        "russian": "Вибрация", "ukrainian": "Вібрація", "german": "Haptisches Feedback",
        "french": "Retour haptique", "spanish": "Vibración", "spanishlatinamerica": "Vibración",
        "portuguese": "Vibração", "polish": "Wibracje", "italian": "Vibrazione",
        "turkish": "Titreşim", "czech": "Vibrace", "swedish": "Vibration",
        "kazakh": "Діріл", "simplifiedchinese": "触感反馈", "japanese": "振動",
        "korean": "진동", "arabic": "الاهتزاز",
    },
    "keep_awake": {
        "russian": "Не гасить экран", "ukrainian": "Не гасити екран", "german": "Bildschirm an lassen",
        "french": "Garder l'écran allumé", "spanish": "Mantener la pantalla activa",
        "spanishlatinamerica": "Mantener la pantalla activa", "portuguese": "Manter a tela ligada",
        "polish": "Nie wygaszaj ekranu", "italian": "Mantieni lo schermo acceso",
        "turkish": "Ekranı açık tut", "czech": "Nevypínat obrazovku", "swedish": "Håll skärmen vaken",
        "kazakh": "Экранды өшірмеу", "simplifiedchinese": "保持屏幕常亮", "japanese": "画面をオフにしない",
        "korean": "화면 켜 두기", "arabic": "إبقاء الشاشة مضاءة",
    },
    "ca_tab_flat": {"russian": "2D", "ukrainian": "2D", "german": "2D", "french": "2D", "spanish": "2D",
                    "spanishlatinamerica": "2D", "portuguese": "2D", "polish": "2D", "italian": "2D",
                    "turkish": "2D", "czech": "2D", "swedish": "2D", "kazakh": "2D",
                    "simplifiedchinese": "2D", "japanese": "2D", "korean": "2D", "arabic": "2D"},
    "ca_tab_3d": {"russian": "3D", "ukrainian": "3D", "german": "3D", "french": "3D", "spanish": "3D",
                  "spanishlatinamerica": "3D", "portuguese": "3D", "polish": "3D", "italian": "3D",
                  "turkish": "3D", "czech": "3D", "swedish": "3D", "kazakh": "3D",
                  "simplifiedchinese": "3D", "japanese": "3D", "korean": "3D", "arabic": "3D"},
    "ca_hint_orbit": {
        "russian": "Потяните, чтобы вращать", "ukrainian": "Потягніть, щоб обертати",
        "german": "Ziehen zum Drehen", "french": "Glissez pour tourner",
        "spanish": "Arrastra para girar", "spanishlatinamerica": "Arrastra para girar",
        "portuguese": "Arraste para girar", "polish": "Przeciągnij, aby obrócić",
        "italian": "Trascina per ruotare", "turkish": "Döndürmek için sürükle",
        "czech": "Tažením otočíte", "swedish": "Dra för att rotera",
        "kazakh": "Айналдыру үшін сүйреңіз", "simplifiedchinese": "拖动旋转",
        "japanese": "ドラッグで回転", "korean": "드래그로 회전", "arabic": "اسحب للتدوير",
    },
    "ca_hint_pinch": {
        "russian": "Щипок для масштаба", "ukrainian": "Щипок для масштабу",
        "german": "Pinch zum Zoomen", "french": "Pincez pour zoomer",
        "spanish": "Pellizca para acercar", "spanishlatinamerica": "Pellizca para acercar",
        "portuguese": "Pinça para ampliar", "polish": "Uszczypnij, aby powiększyć",
        "italian": "Pizzica per lo zoom", "turkish": "Yakınlaştırmak için sıkıştır",
        "czech": "Štípnutím přiblížíte", "swedish": "Nyp för att zooma",
        "kazakh": "Масштабтау үшін қысыңыз", "simplifiedchinese": "双指缩放",
        "japanese": "ピンチでズーム", "korean": "핀치로 확대/축소", "arabic": "اقرص للتكبير",
    },
    "ca_loading": {
        "russian": "Загружаем 3D…", "ukrainian": "Завантажуємо 3D…", "german": "3D wird geladen…",
        "french": "Chargement de la 3D…", "spanish": "Cargando 3D…", "spanishlatinamerica": "Cargando 3D…",
        "portuguese": "Carregando 3D…", "polish": "Ładowanie 3D…", "italian": "Caricamento 3D…",
        "turkish": "3D yükleniyor…", "czech": "Načítání 3D…", "swedish": "Laddar 3D…",
        "kazakh": "3D жүктелуде…", "simplifiedchinese": "正在加载 3D…", "japanese": "3Dを読み込み中…",
        "korean": "3D 불러오는 중…", "arabic": "جارٍ تحميل 3D…",
    },
    "ca_reset_view": {
        "russian": "Сбросить вид", "ukrainian": "Скинути вигляд", "german": "Ansicht zurücksetzen",
        "french": "Réinitialiser la vue", "spanish": "Restablecer vista",
        "spanishlatinamerica": "Restablecer vista", "portuguese": "Redefinir visão",
        "polish": "Resetuj widok", "italian": "Reimposta vista", "turkish": "Görünümü sıfırla",
        "czech": "Obnovit zobrazení", "swedish": "Återställ vy", "kazakh": "Көріністі қалпына келтіру",
        "simplifiedchinese": "重置视图", "japanese": "視点をリセット", "korean": "보기 초기화",
        "arabic": "إعادة ضبط العرض",
    },
    "leave_confirm_text": {
        "russian": "Выйти из игры? Если идёт раунд, это засчитается как пропуск.",
        "ukrainian": "Вийти з гри? Якщо йде раунд, це зарахують як пропуск.",
        "german": "Spiel verlassen? Eine laufende Runde zählt als Pass.",
        "french": "Quitter la partie ? Un tour en cours comptera comme une passe.",
        "spanish": "¿Salir de la partida? Si hay una ronda en curso contará como pase.",
        "spanishlatinamerica": "¿Salir de la partida? Si hay una ronda en curso contará como pase.",
        "portuguese": "Sair do jogo? Se houver uma rodada em andamento, contará como passe.",
        "polish": "Wyjść z gry? Trwająca runda zostanie uznana za pas.",
        "italian": "Uscire dalla partita? Un round in corso conterà come passaggio.",
        "turkish": "Oyundan çıkılsın mı? Süren tur pas sayılır.",
        "czech": "Opustit hru? Probíhající kolo se počítá jako pas.",
        "swedish": "Lämna spelet? En pågående runda räknas som pass.",
        "kazakh": "Ойыннан шығасыз ба? Раунд жүріп жатса, пас болып саналады.",
        "simplifiedchinese": "退出游戏？正在进行的回合将计为跳过。",
        "japanese": "ゲームを退出しますか？進行中のラウンドはパス扱いになります。",
        "korean": "게임을 나갈까요? 진행 중인 라운드는 패스로 처리됩니다.",
        "arabic": "هل تريد مغادرة اللعبة؟ الجولة الجارية ستُحسب تمريرًا.",
    },
    "cancel": {
        "russian": "Отмена", "ukrainian": "Скасувати", "german": "Abbrechen", "french": "Annuler",
        "spanish": "Cancelar", "spanishlatinamerica": "Cancelar", "portuguese": "Cancelar",
        "polish": "Anuluj", "italian": "Annulla", "turkish": "İptal", "czech": "Zrušit",
        "swedish": "Avbryt", "kazakh": "Болдырмау", "simplifiedchinese": "取消",
        "japanese": "キャンセル", "korean": "취소", "arabic": "إلغاء",
    },
}

KEY_RE = re.compile(r"^[A-Za-z0-9_ :'\u2019.!?\-\u2014]+$")


def scrape_english() -> dict:
    try:
        req = urllib.request.Request(UPSTREAM, headers={"User-Agent": "PQRevamped-i18n-sync"})
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8-sig"))
    except Exception as exc:  # noqa: BLE001 - offline is a normal case for a maintainer
        print(f"  ! could not reach upstream ({exc}); keeping local English", file=sys.stderr)
        return {}


def load(path: Path) -> dict:
    with path.open(encoding="utf-8-sig") as fh:
        return json.load(fh)


def dump(path: Path, data: dict) -> None:
    ordered = {key: data[key] for key in sorted(data, key=lambda k: (k.lower(), k))}
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(ordered, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scrape", action="store_true", help="fill missing keys from partyquiz.club")
    args = parser.parse_args()

    english_path = LOCALIZED / "english" / "lang.json"
    english = load(english_path)
    changed = False

    if args.scrape:
        upstream = scrape_english()
        for key, value in upstream.items():
            if key not in english:
                print(f"  + {key} (from upstream)")
                english[key] = value
                changed = True

    for key, value in REVAMPED_KEYS.items():
        if key not in english:
            english[key] = value
            changed = True

    # A rewritten default has to reach the locales that still carry the old copy:
    # they inherit English verbatim, so a stale string would survive the fix.
    for key, value in REVAMPED_KEYS.items():
        if english.get(key) != value:
            english[key] = value
            changed = True

    if changed:
        dump(english_path, english)

    missing_report = {}
    for lang_dir in sorted(p for p in LOCALIZED.iterdir() if p.is_dir()):
        lang = lang_dir.name
        path = lang_dir / "lang.json"
        data = load(path)
        before = len(data)

        for key in english:
            if key in data and not (key in REVAMPED_KEYS and key not in TRANSLATIONS.get(key, {})):
                continue
            value = TRANSLATIONS.get(key, {}).get(lang) or english[key]
            if data.get(key) != value:
                data[key] = value

        for key, table in TRANSLATIONS.items():
            if lang in table and data.get(key) != table[lang]:
                data[key] = table[lang]

        if len(data) != before or lang != "english":
            dump(path, data)

        missing = [key for key in english if key not in data]
        untranslated = [key for key in english if data.get(key) == english.get(key) and key in TRANSLATIONS]
        if missing:
            missing_report[lang] = missing
        print(f"  {lang:22} {len(data):4} keys"
              + (f"  missing {len(missing)}" if missing else "")
              + (f"  untranslated {len(untranslated)}" if untranslated else ""))

    if missing_report:
        print("Keys still missing:", missing_report, file=sys.stderr)
        return 1
    print(f"\nEnglish dictionary: {len(english)} keys across {len(list(LOCALIZED.iterdir()))} locales")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
