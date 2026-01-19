<script>
(function(){
  const form = document.getElementById('olympeus-form');
  const input = document.getElementById('olympeus-input');
  const messagesEl = document.getElementById('olympeus-messages');
  const btn = form ? form.querySelector('button[type="submit"]') : null;

  if(!form || !input || !messagesEl){
    console.error("Olympeus: éléments introuvables", {form, input, messagesEl});
    return;
  }

  function addMsg(text, who){
    const div = document.createElement('div');
    div.style.margin = '8px 0';
    div.innerHTML = `<b>${who === 'user' ? 'Vous' : 'Olympeus'} :</b> ${String(text)}`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function send(message){
    const url = "/wp-json/olympeus/v1/chat";
    console.log("Olympeus send ->", url, message);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        expert: false,
        web: { enabled: false, query: "" }
      })
    });

    const text = await res.text();
    console.log("Olympeus response status:", res.status, "raw:", text);

    let data = null;
    try { data = JSON.parse(text); } catch(e){}

    if(!res.ok){
      const err = (data && (data.error || data.message)) ? (data.error || data.message) : ("HTTP " + res.status);
      throw new Error(err);
    }

    return (data && (data.answer || data.response || data.message)) ? (data.answer || data.response || data.message) : text;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = (input.value || "").trim();
    if(!msg) return;

    input.value = "";
    addMsg(msg, "user");

    if(btn) btn.disabled = true;

    // petit “typing”
    const typing = document.createElement('div');
    typing.style.margin = '8px 0';
    typing.innerHTML = "<b>Olympeus :</b> ...";
    messagesEl.appendChild(typing);

    try{
      const answer = await send(msg);
      typing.innerHTML = "<b>Olympeus :</b> " + String(answer);
    }catch(err){
      typing.innerHTML = "<b>Olympeus :</b> ❌ " + err.message;
      console.error("Olympeus error:", err);
    }finally{
      if(btn) btn.disabled = false;
    }
  });
})();
</script>
