"""Hardcoded inventory: activities (with HSP-based weights) and apps/websites.

Weights are 1-10: how strongly the activity overstimulates a highly sensitive
person (Aron, *The Highly Sensitive Person*: sensory intensity, emotional
processing depth, social pressure, and interruption all raise arousal).
Edit freely - this file is the single source of truth.
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
}

# app key -> (aliases typed by user, url, default activity, [activities it supports])
APPS = {
    "instagram": (["instagram", "insta", "ig"], "https://www.instagram.com/", "social_profiles",
                  ["short_videos", "social_profiles", "notifications", "intense_convo", "loud_video", "after_busy_day", "before_sleep", "app_switching"]),
    "youtube": (["youtube", "yt"], "https://www.youtube.com/", "loud_video",
                ["short_videos", "loud_video", "after_busy_day", "before_sleep", "app_switching"]),
    "tiktok": (["tiktok"], "https://www.tiktok.com/", "short_videos", ["short_videos", "loud_video"]),
    "snapchat": (["snapchat", "snap"], "https://www.snapchat.com/spotlight", "short_videos", ["short_videos"]),
    "whatsapp": (["whatsapp", "wa"], "https://web.whatsapp.com/", "group_chats",
                 ["group_chats", "intense_convo", "notifications", "work_messages", "before_sleep", "app_switching"]),
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
    "kindle": (["kindle"], "https://read.amazon.com/", "long_articles", ["long_articles", "before_sleep"]),
    "amazon": (["amazon"], "https://www.amazon.in/", "shopping", ["shopping"]),
    "flipkart": (["flipkart"], "https://www.flipkart.com/", "shopping", ["shopping"]),
    "myntra": (["myntra"], "https://www.myntra.com/", "shopping", ["shopping"]),
    "ajio": (["ajio"], "https://www.ajio.com/", "shopping", ["shopping"]),
    "pinterest": (["pinterest"], "https://www.pinterest.com/", "shopping", ["shopping"]),
}

# (app, activity) -> specific URL, when it differs from the app's home page
URL_OVERRIDES = {
    ("instagram", "short_videos"): "https://www.instagram.com/reels/",
    ("instagram", "intense_convo"): "https://www.instagram.com/direct/inbox/",
    ("youtube", "short_videos"): "https://www.youtube.com/shorts",
    ("reddit", "news"): "https://www.reddit.com/r/news/",
}
