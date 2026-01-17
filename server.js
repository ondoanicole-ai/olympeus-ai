<div id="olympeus-ai" style="max-width:900px;margin:40px auto;padding:24px;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.08);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;">
  <h2 style="text-align:center;margin:0 0 18px;letter-spacing:1px;">OLYMPEUS-AI</h2>

  <div id="olympeus-messages" style="min-height:220px;max-height:420px;overflow:auto;padding:14px;border:1px solid #eee;border-radius:12px;background:#fafafa;"></div>

  <div style="display:flex;gap:18px;align-items:center;margin:14px 0 10px;">
    <label style="display:flex;gap:8px;align-items:center;font-size:14px;opacity:.9;cursor:pointer;">
      <input type="checkbox" id="olympeus-web">
      Recherche web
    </label>

    <label style="display:flex;gap:8px;align-items:center;font-size:14px;opacity:.9;cursor:pointer;">
      <input type="checkbox" id="olympeus-expert">
      Mode expert
    </label>

    <span id="olympeus-status" style="margin-left:auto;font-size:13px;opacity:.7;"></span>
  </div>

  <form id="olympeus-form" style="display:flex;gap:10px;align-items:center;">
    <input id="olympeus-input" placeholder="Écris ton message..." autocomplete="off"
      style="flex:1;padding:12px 14px;border-radius:10px;border:1px solid #ddd;outline:none;font-size:15px;">
    <button id="olympeus-send" type="submit"
      style="padding:12px 16px;border-radius:10px;border:0;background:#1d4ed8;color:#fff;font-weight:600;cursor:pointer;">
      Envoyer
    </button>
  </form>
</div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const box = $("olympeus-messages");
  const form = $("olympeus-form");
  const input = $("olympeus-input");
  const webCb = $("olympeus-web");
  const expertCb = $("olympeus-expert");
  const status = $("olympeus-status");
  const btn = $("olympeus-send");

  let conversationId = localStorage.getItem("olympeus_conversationId") || "";

  function addMsg(text, who) {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.justifyContent = who === "user" ? "flex-end" : "flex-start";
    wrap.style.margin = "10px 0";

    const bubble = document.createElement("div");
    bubble.style.maxWidth = "75%";
    bubble.style.padding = "10px 12px";
    bubble.style.borderRadius = "12px";
    bubble.style.whiteSpace = "pre-wrap";
    bubble.style.lineHeight = "1.35";
    bubble.style.fontSize = "15px";

    if (who === "user") {
      bubble.style.background = "#111827";
      bubble.style.color = "#fff";
      bubble.textContent = text;
    } else if (who === "error") {
      bubble.style.background = "#fee2e2";
      bubble.style.color = "#7f1d1d";
      bubble.textContent = text;
    } else {
      bubble.style.background = "#fff";
      bubble.style.border = "1px solid #eee";
      bubble.textContent = text;
    }

    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  function setLoading(isLoading) {
    btn.disabled = isLoading;
    btn.style.opacity = isLoading ? "0.7" : "1";
    status.textContent = isLoading ? "Réponse en cours..." : "";
  }

  async function sendMessage(message) {
    setLoading(true);
    addMsg(message, "user");

    const payload = {
      message,
      conversationId,
      expert: !!expertCb.checked,
      web: {
        enabled: !!webCb.checked,
        query: ""
      }
    };

    try {
      const res = await fetch("/wp-json/olympeus/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.ok === false) {
        const msg = data.error || ("Erreur API (" + res.status + ")");
        addMsg(msg, "error");
        setLoading(false);
        return;
      }

      if (data.conversationId) {
        conversationId = data.conversationId;
        localStorage.setItem("olympeus_conversationId", conversationId);
      }

      addMsg(data.answer || "Réponse vide.", "assistant");
    } catch (e) {
      addMsg("Erreur réseau: " + (e && e.message ? e.message : "inconnue"), "error");
    } finally {
      setLoading(false);
    }
  }

  addMsg('Bonjour 👋 Pose ta question. Tu peux activer "Recherche web" si nécessaire.', "assistant");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = (input.value || "").trim();
    if (!msg) return;
    input.value = "";
    sendMessage(msg);
  });
})();
</script>
