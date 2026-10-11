import json
import os
import base64
import requests
from http.server import BaseHTTPRequestHandler

# Чтение сценария из локальной папки (быстро и бесплатно на Vercel)
def load_scenario(scenario_id: str) -> dict:
    try:
        with open(f"scenarios/{scenario_id}.json", "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None

# Получение токена GigaChat
def get_gigachat_token() -> str:
    client_id = os.environ.get("GIGACHAT_CLIENT_ID")
    client_secret = os.environ.get("GIGACHAT_CLIENT_SECRET")
    
    if not client_id or not client_secret:
        raise Exception("GigaChat credentials not found in environment variables")

    auth_string = f"{client_id}:{client_secret}"
    base64_auth = base64.b64encode(auth_string.encode("utf-8")).decode("utf-8")
    
    headers = {
        "Authorization": f"Basic {base64_auth}",
        "RqUID": "vercel-serverless-req-001", # Уникальный ID запроса
        "Content-Type": "application/json"
    }
    
    # Для тестовой среды GigaChat используется этот URL
    url = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    
    response = requests.post(url, headers=headers, data={"scope": "GIGACHAT_API_PERS"}, verify=False)
    response.raise_for_status()
    return response.json()["access_token"]

# Основной обработчик запросов Vercel
def handler(req):
    # Разрешаем CORS для локальной разработки и Vercel
    if req.method == "OPTIONS":
        return (200, {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"}, "")

    if req.method != "POST":
        return (405, {"Content-Type": "application/json"}, json.dumps({"error": "Method not allowed"}))

    try:
        content_length = int(req.headers.get("Content-Length", 0))
        body = req.rfile.read(content_length).decode("utf-8")
        data = json.loads(body)
        
        scenario_id = data.get("scenario_id")
        user_message = data.get("user_message")
        chat_history = data.get("history", [])

        scenario = load_scenario(scenario_id)
        if not scenario:
            return (404, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, json.dumps({"error": "Scenario not found"}))

        # 1. Проверка динамических триггеров
        updated_elements = scenario["active_elements"].copy()
        for trigger in scenario.get("dynamic_triggers", []):
            import re
            if re.search(trigger["keyword"], user_message, re.IGNORECASE):
                action = trigger["action"]
                if action == "show_calendar":
                    updated_elements["calendar"] = True
                elif action == "show_dashboard":
                    updated_elements["dashboard"] = True
                elif action == "show_tasks":
                    updated_elements["tasks"] = True
                elif action == "show_email":
                    updated_elements["email"] = True

        # 2. Формирование системного промпта
        persona = scenario["ai_persona"]
        system_prompt = f"""Ты играешь роль: {persona['name']}, {persona['role']}.
Твое скрытое состояние: {persona['hidden_state']}.
Твой стиль общения: {persona['communication_style']}.
Контекст ситуации: {scenario['context']}.
Цель игрока (руководителя): {scenario['player_goal']}.

Правила:
1. Отвечай ТОЛЬКО от лица персонажа, коротко (1-3 предложения), как в рабочем чате.
2. Не используй форматирование Markdown, пиши как живой человек в мессенджере.
3. Если игрок проявляет эмпатию и использует правильные техники, постепенно раскрывай свое скрытое состояние.
4. Если игрок токсичен, дави или игнорирует чувства, замыкайся, отвечай односложно или проявляй пассивную агрессию.
5. НИКОГДА не раскрывай, что ты ИИ или что это игра."""

        # Формируем историю сообщений для GigaChat
        messages = [{"role": "system", "content": system_prompt}]
        for msg in chat_history:
            messages.append({"role": msg["role"], "content": msg["content"]})
        messages.append({"role": "user", "content": user_message})

        # 3. Запрос к GigaChat
        token = get_gigachat_token()
        gigachat_url = "https://ngw.devices.sberbank.ru:9443/api/v1/chat/completions"
        
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "GigaChat", # Или "GigaChat-Pro", если есть доступ
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 150
        }
        
        response = requests.post(gigachat_url, headers=headers, json=payload, verify=False)
        response.raise_for_status()
        
        ai_response = response.json()["choices"][0]["message"]["content"].strip()

        # 4. Возврат результата
        result = {
            "ai_response": ai_response,
            "updated_elements": updated_elements
        }
        
        return (200, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, json.dumps(result))

    except Exception as e:
        return (500, {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}, json.dumps({"error": str(e)}))

# Адаптер для Vercel Python Serverless Functions
from http.server import BaseHTTPRequestHandler
class VercelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        status, headers, body = handler(self)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))
