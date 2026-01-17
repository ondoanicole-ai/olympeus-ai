document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("olympeus-form");
  const input = document.getElementById("olympeus-input");
  const messages = document.getElementById("olympeus-messages");
  const webCheckbox = document.getElementById("olympeus-web");
  const expertCheckbox = document.getElementById("olympeus-expert");

  if (!form || !input || !messages) {
    console.error("Olympeus AI: éléments manquants dans le DOM");
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
      message: message,
      conversationId: conversationId,
      expert: !!expertCheckbox?.checked,
      web: {
        enabled: !!webCheckbox?.checked,
        query: message
      }
    };

    try {
      const response = await fetch("/wp-json/olympeus/v1/chat", {
        method: "POST",

        // 🔥 CORRECTIF CRITIQUE 401
        // On empêche WordPress d’envoyer les cookies (sinon nonce exigé)
        credentials: "omit",

        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Erreur API (${response.status}) : ${text}`);
      }

      const data = await response.json();

      if (data.conversationId) {
        conversationId = data.conversationId;
      }

      addMessage(data.answer || "Réponse vide.", "assistant");

    } catch (err) {
      console.error("Olympeus AI error:", err);
      addMessage("❌ Erreur API. Veuillez réessayer.", "error");
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    sendMessage(message);
  });
});
