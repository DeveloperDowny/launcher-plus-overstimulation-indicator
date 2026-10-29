"""Hardcoded inventory: activities (with HSP-based weights) and apps/websites.

Weights are 1-10: how strongly the activity overstimulates a highly sensitive
person (Aron, *The Highly Sensitive Person*: sensory intensity, emotional
processing depth, social pressure, and interruption all raise arousal).
Negative weights are calming activities: they lower the level instead of raising it.
Weight 0 is neutral: logged, but the level doesn't move.
Edit freely - this file is the single source of truth. After editing, run
`python inventory.py` to regenerate web/inventory.json for the web app.
"""

# id -> (label, weight, mode keywords)
ACTIVITIES = {
    "short_videos":   ("Rapidly scrolling short videos", 10, ["reels", "shorts", "spotlight", "scroll"]),
    "loud_video":     ("Videos with loud audio / flashing visuals / rapid cuts", 9, ["video", "watch", "loud"]),
    "games":          ("Fast-paced mobile games", 9, ["game", "play"]),
    "intense_convo":  ("Emotionally intense conversations", 8, ["dm", "dms", "heated", "intense"]),
    "before_sleep":   ("Phone use before sleep", 8, ["bedtime", "sleep", "night"]),
    "app_switching":  ("Switching rapidly between apps", 8, []),  # auto-detected, see launcher.py
    "news":           ("Reading news feeds", 7, ["news", "feed", "headlines"]),
    "group_chats":    ("Participating in group chats", 7, ["group", "groups"]),
    "after_busy_day": ("Phone use right after a busy day", 7, ["tired", "evening", "busyday"]),
    "notifications":  ("Checking notifications repeatedly", 6, ["notifications", "notifs", "inbox"]),
    "social_profiles": ("Browsing social media profiles", 6, ["profile", "profiles"]),
    "shopping":       ("Shopping / browsing recommendations", 6, ["shop", "shopping", "deals"]),
    "work_messages":  ("Checking messages while working/studying", 6, ["working", "work", "study", "studying"]),
    "ai_chat":        ("AI chat across unrelated topics", 5, ["ask", "ai"]),
    "long_articles":  ("Long, information-dense articles", 4, ["read", "article", "articles", "paper", "papers"]),
    # --- calming activities (negative weight = recovery) ---
    "breathing":      ("Guided breathing", -4, ["breathe", "breathing"]),
    "meditation":     ("Guided meditation / body scan", -4, ["meditate", "meditation", "bodyscan"]),
    "calm_music":     ("Calming instrumental music", -3, ["music", "calm", "instrumental"]),
    "nature_sounds":  ("Nature sounds", -3, ["nature", "sounds"]),
    "relaxation":     ("Guided relaxation exercise", -3, ["relax", "relaxation"]),
    "brain_dump":     ("Brain dump in a notes app", -3, ["dump", "braindump", "notes"]),
    "journaling":     ("Journaling / gratitude reflection", -3, ["journal", "journaling", "gratitude"]),
    "stretching":     ("Gentle stretching / yoga", -3, ["stretch", "stretching", "yoga"]),
    "sleep_audio":    ("Sleep story / bedtime audio", -3, ["sleepstory", "story"]),
    "calm_reading":   ("Familiar book, calming fiction or poetry", -2, ["fiction", "poetry", "novel", "calmread"]),
    "audiobook":      ("Familiar audiobook", -2, ["audiobook", "listen"]),
    "mood_checkin":   ("Simple mood check-in", -2, ["mood", "checkin"]),
    "nature_visuals": ("Calming nature photos / slow nature video", -2, ["photos", "scenery", "slow"]),
    "screen_timer":   ("Timer for a screen break / sitting quietly", -2, ["timer", "quiet", "sit"]),
    "trusted_msg":    ("One message to a trusted person", -2, ["trusted", "friend"]),
    # --- neutral (weight 0: logged only, level unchanged) ---
    "going_to_sleep": ("Going to sleep", 0, ["bed", "gotosleep"]),
    "back_to_work":   ("Going back to work", 0, ["backtowork", "resume"]),
    "roulette":       ("Spin the calming-activity roulette", 0, ["spin", "roulette"]),
    "gita_a_day":     ("Bhagwat Gita a Day", 0, ["gita", "verse"]),
    "breakfast":      ("Breakfast", 0, ["breakfast"]),
    "lunch":          ("Lunch", 0, ["lunch"]),
    "dinner":         ("Dinner", 0, ["dinner"]),
}

# when a launch or "feel" pushes the level into the frayed band, this list is
# copied to the clipboard and the roulette site is opened
ROULETTE_URL = "https://roulette-s-v1.el.r.appspot.com/"
ROULETTE_CLIPBOARD = """Visualize your comfort place for 1 min, 1
Count breaths 1 set, 1
Count breaths 2 set, 1
One headspace session, 1
One headspace podcast, 1
One headspace sleep sound, 1
Reading any book 3 pages, 1
Reading book 10 pages, 1
Reading boom 10 minutes, 1
Gently bring attention to current task, 1"""

# app key -> (aliases typed by user, url, default activity, [activities it supports])
APPS = {
    "instagram": (["instagram", "insta", "ig"], "https://www.instagram.com/", "social_profiles",
                  ["short_videos", "social_profiles", "notifications", "intense_convo", "loud_video", "after_busy_day", "before_sleep", "app_switching"]),
    "youtube": (["youtube", "yt"], "https://www.youtube.com/", "loud_video",
                ["short_videos", "loud_video", "after_busy_day", "before_sleep", "app_switching",
                 "nature_sounds", "nature_visuals", "relaxation", "stretching", "meditation", "calm_music"]),
    "tiktok": (["tiktok"], "https://www.tiktok.com/", "short_videos", ["short_videos", "loud_video"]),
    "snapchat": (["snapchat", "snap"], "https://www.snapchat.com/spotlight", "short_videos", ["short_videos"]),
    "whatsapp": (["whatsapp", "wa"], "https://web.whatsapp.com/", "group_chats",
                 ["group_chats", "intense_convo", "notifications", "work_messages", "before_sleep", "app_switching", "trusted_msg"]),
    "gmail": (["gmail", "email", "mail"], "https://mail.google.com/", "notifications", ["notifications", "work_messages"]),
    "slack": (["slack"], "https://app.slack.com/", "work_messages", ["notifications", "group_chats", "work_messages"]),
    "teams": (["microsoft teams", "teams", "ms teams"], "https://teams.microsoft.com/", "work_messages",
              ["notifications", "group_chats", "work_messages"]),
    "telegram": (["telegram"], "https://web.telegram.org/", "group_chats", ["group_chats", "intense_convo"]),
    "discord": (["discord"], "https://discord.com/app", "group_chats", ["group_chats", "work_messages"]),
    "messenger": (["messenger"], "https://www.messenger.com/", "intense_convo", ["intense_convo"]),
    "imessage": (["imessage"], "https://www.icloud.com/", "intense_convo", ["intense_convo"]),
    "chrome": (["chrome"], "https://www.google.com/", "app_switching", ["app_switching"]),
    "reddit": (["reddit"], "https://www.reddit.com/", "news", ["news", "after_busy_day", "before_sleep", "app_switching"]),
    "x": (["x", "twitter"], "https://x.com/", "news", ["news", "social_profiles", "after_busy_day"]),
    "linkedin": (["linkedin"], "https://www.linkedin.com/", "social_profiles", ["social_profiles"]),
    "facebook": (["facebook", "fb"], "https://www.facebook.com/", "social_profiles", ["social_profiles"]),
    "google news": (["google news"], "https://news.google.com/", "news", ["news"]),
    "inshorts": (["inshorts"], "https://inshorts.com/", "news", ["news"]),
    "ndtv": (["ndtv"], "https://www.ndtv.com/", "news", ["news"]),
    "bbc news": (["bbc news", "bbc"], "https://www.bbc.com/news", "news", ["news"]),
    "netflix": (["netflix"], "https://www.netflix.com/", "loud_video", ["loud_video", "after_busy_day", "before_sleep"]),
    "bgmi": (["bgmi"], "https://www.battlegroundsmobileindia.com/", "games", ["games"]),
    "cod mobile": (["call of duty mobile", "call of duty", "cod mobile", "cod"], "https://www.callofduty.com/mobile", "games", ["games"]),
    "free fire": (["free fire", "freefire"], "https://ff.garena.com/", "games", ["games"]),
    "clash royale": (["clash royale"], "https://clashroyale.com/", "games", ["games"]),
    "chatgpt": (["chatgpt", "gpt"], "https://chatgpt.com/", "ai_chat", ["ai_chat"]),
    "claude": (["claude"], "https://claude.ai/", "ai_chat", ["ai_chat"]),
    "gemini": (["gemini"], "https://gemini.google.com/", "ai_chat", ["ai_chat"]),
    "perplexity": (["perplexity"], "https://www.perplexity.ai/", "ai_chat", ["ai_chat"]),
    "copilot": (["github copilot", "copilot"], "https://github.com/copilot", "ai_chat", ["ai_chat"]),
    "medium": (["medium"], "https://medium.com/", "long_articles", ["long_articles"]),
    "substack": (["substack"], "https://substack.com/", "long_articles", ["long_articles"]),
    "wikipedia": (["wikipedia", "wiki"], "https://www.wikipedia.org/", "long_articles", ["long_articles"]),
    "scholar": (["google scholar", "scholar"], "https://scholar.google.com/", "long_articles", ["long_articles"]),
    "kindle": (["kindle"], "https://read.amazon.com/", "long_articles", ["long_articles", "before_sleep", "calm_reading"]),
    "amazon": (["amazon"], "https://www.amazon.in/", "shopping", ["shopping"]),
    "flipkart": (["flipkart"], "https://www.flipkart.com/", "shopping", ["shopping"]),
    "myntra": (["myntra"], "https://www.myntra.com/", "shopping", ["shopping"]),
    "ajio": (["ajio"], "https://www.ajio.com/", "shopping", ["shopping"]),
    "pinterest": (["pinterest"], "https://www.pinterest.com/", "shopping", ["shopping"]),
    # --- calming apps / sites ---
    "spotify": (["spotify"], "https://open.spotify.com/", "calm_music", ["calm_music", "nature_sounds", "audiobook", "sleep_audio"]),
    "youtube music": (["youtube music", "ytmusic"], "https://music.youtube.com/", "calm_music", ["calm_music", "nature_sounds"]),
    "apple music": (["apple music"], "https://music.apple.com/", "calm_music", ["calm_music"]),
    "calm": (["calm app", "calm.com"], "https://www.calm.com/", "relaxation", ["relaxation", "breathing", "meditation", "nature_sounds", "sleep_audio"]),
    "headspace": (["headspace"], "https://www.headspace.com/", "meditation", ["meditation", "breathing", "relaxation", "sleep_audio"]),
    "medito": (["medito"], "https://meditofoundation.org/", "meditation", ["meditation", "breathing"]),
    "insight timer": (["insight timer", "insighttimer"], "https://insighttimer.com/", "meditation", ["meditation", "relaxation"]),
    "mynoise": (["mynoise"], "https://mynoise.net/", "nature_sounds", ["nature_sounds"]),
    "breathwrk": (["breathwrk"], "https://breathwrk.com/", "breathing", ["breathing"]),
    "ucla mindful": (["ucla mindful", "ucla"], "https://www.uclahealth.org/programs/marc/free-guided-meditations", "meditation", ["meditation"]),
    "libby": (["libby"], "https://libbyapp.com/", "calm_reading", ["calm_reading", "audiobook"]),
    "google play books": (["google play books", "play books"], "https://play.google.com/store/books", "calm_reading", ["calm_reading", "audiobook"]),
    "poetry foundation": (["poetry foundation", "poetry"], "https://www.poetryfoundation.org/", "calm_reading", ["calm_reading"]),
    "audible": (["audible"], "https://www.audible.in/", "audiobook", ["audiobook", "sleep_audio"]),
    "storytel": (["storytel"], "https://www.storytel.com/", "audiobook", ["audiobook"]),
    "google keep": (["google keep", "keep"], "https://keep.google.com/", "brain_dump", ["brain_dump", "journaling"]),
    "simplenote": (["simplenote"], "https://app.simplenote.com/", "brain_dump", ["brain_dump", "journaling"]),
    "notion": (["notion"], "https://www.notion.so/", "brain_dump", ["brain_dump", "journaling"]),
    "day one": (["day one", "dayone"], "https://dayoneapp.com/", "journaling", ["journaling"]),
    "daylio": (["daylio"], "https://daylio.net/", "mood_checkin", ["mood_checkin"]),
    "bearable": (["bearable"], "https://bearable.app/", "mood_checkin", ["mood_checkin"]),
    "how we feel": (["how we feel", "howwefeel"], "https://howwefeel.org/", "mood_checkin", ["mood_checkin"]),
    "unsplash": (["unsplash"], "https://unsplash.com/s/photos/nature", "nature_visuals", ["nature_visuals"]),
    "google photos": (["google photos"], "https://photos.google.com/", "nature_visuals", ["nature_visuals"]),
    "bbc earth": (["bbc earth"], "https://www.bbcearth.com/", "nature_visuals", ["nature_visuals"]),
    "alltrails": (["alltrails"], "https://www.alltrails.com/", "nature_visuals", ["nature_visuals"]),
    "down dog": (["down dog", "downdog"], "https://www.downdogapp.com/", "stretching", ["stretching"]),
    "yoga with adriene": (["yoga with adriene", "adriene"], "https://yogawithadriene.com/", "stretching", ["stretching"]),
    "timer": (["timer", "google timer"], "https://www.google.com/search?q=timer", "screen_timer", ["screen_timer"]),
    "forest": (["forest"], "https://www.forestapp.cc/", "screen_timer", ["screen_timer"]),
    "signal": (["signal"], "https://signal.org/", "trusted_msg", ["trusted_msg"]),
    "roulette": (["roulette"], ROULETTE_URL, "roulette", ["roulette"]),
    # --- dummy launches (no url: nothing opens, the event is just logged) ---
    "sleep": (["going to sleep", "go to sleep", "sleep", "bed"], "", "going_to_sleep", ["going_to_sleep"]),
    "back to work": (["going back to work", "back to work", "work"], "", "back_to_work", ["back_to_work"]),
    "gita a day": (["bhagwat gita a day", "bhagavad gita a day", "bhagwat gita", "bhagavad gita", "gita a day", "gita"], "", "gita_a_day", ["gita_a_day"]),
    "breakfast": (["breakfast"], "", "breakfast", ["breakfast"]),
    "lunch": (["lunch"], "", "lunch", ["lunch"]),
    "dinner": (["dinner"], "", "dinner", ["dinner"]),
}

# (app, activity) -> specific URL, when it differs from the app's home page
URL_OVERRIDES = {
    ("instagram", "short_videos"): "https://www.instagram.com/reels/",
    ("instagram", "intense_convo"): "https://www.instagram.com/direct/inbox/",
    ("youtube", "short_videos"): "https://www.youtube.com/shorts",
    ("reddit", "news"): "https://www.reddit.com/r/news/",
    ("youtube", "nature_sounds"): "https://www.youtube.com/results?search_query=nature+sounds+relaxing",
    ("youtube", "nature_visuals"): "https://www.youtube.com/results?search_query=slow+nature+scenery+no+talking",
    ("youtube", "relaxation"): "https://www.youtube.com/results?search_query=guided+relaxation",
    ("youtube", "stretching"): "https://www.youtube.com/results?search_query=gentle+stretching+yoga",
    ("youtube", "meditation"): "https://www.youtube.com/results?search_query=guided+meditation+body+scan",
    ("youtube", "calm_music"): "https://www.youtube.com/results?search_query=calming+instrumental+music",
    ("spotify", "nature_sounds"): "https://open.spotify.com/search/nature%20sounds",
    ("spotify", "sleep_audio"): "https://open.spotify.com/search/sleep%20stories",
}


if __name__ == "__main__":  # regenerate web/inventory.json
    import json
    from pathlib import Path
    out = {
        "activities": {k: {"label": l, "weight": w, "modes": m} for k, (l, w, m) in ACTIVITIES.items()},
        "apps": {k: {"aliases": a, "url": u, "default": d, "supports": sup} for k, (a, u, d, sup) in APPS.items()},
        "urlOverrides": {f"{a}|{b}": u for (a, b), u in URL_OVERRIDES.items()},
        "roulette": {"url": ROULETTE_URL, "clipboard": ROULETTE_CLIPBOARD},
    }
    Path(__file__).with_name("web").joinpath("inventory.json").write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {len(out['activities'])} activities, {len(out['apps'])} apps")
