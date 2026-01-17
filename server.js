document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("olympeus-form");
  const input = document.getElementById("olympeus-input");
  const messages = document.getElementById("olympeus-messages");
  const webCheckbox = document.getElementById("olympeus-web");
  const expertCheckbox = document.getElementById("olympeus-expert");

  if (!form || !input || !messages) {
    console.error("Olympeus AI: éléments manquants");
    return;
  }

  let conversationId = null;

  function addMessage(content, type = "assistant") {
    const div = document.createElement("div");
    div.className = `olympeus-message ${type}`;
    div.textContent = content;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage(message) {
    addMessage(message, "user");

    const payload = {
      message,
      conversationId,
      expert: !!expertCheckbox?.checked,
      web: {
        enabled: !!webCheckbox?.checked,
        query: message
      }
    };

    try {
      const wp = window.OLYMPEUS_WP || {};
      const endpoint = (wp.rest ? wp.rest : "/wp-json/") + "olympeus/v1/chat";

      const res = await fetch(endpoint, {
        method: "POST",

        // ✅ ON GARDE LES COOKIES WP (sinon WP ne reconnait pas l'utilisateur)
        credentials: "same-origin",

        headers: {
          "Content-Type": "application/json",
          // ✅ NONCE VALIDE (injecté par le snippet PHP)
          ...(wp.nonce ? { "X-WP-Nonce": wp.nonce } : {})
        },

        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }

      const data = await res.json();

      if (data.conversationId) conversationId = data.conversationId;

      addMessage(data.answer || "Réponse vide.", "assistant");
    } catch (err) {
      console.error("Olympeus AI:", err);
      addMessage("❌ Erreur API. Vérifie les logs Render/WP.", "error");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    sendMessage(msg);
  });
});


