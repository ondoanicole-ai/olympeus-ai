<?php
/**
 * Olympeus AI - Public chat (visiteurs) + Token + Rate limit
 * Shortcode: [olympeus_ai]
 */

/** ========= A) CONFIG ========= */
define('OLYMPEUS_RENDER_URL', 'https://olympeus-ai.onrender.com/post-assist'); // ton endpoint Render
define('OLYMPEUS_SHARED_TOKEN', 'REPLACE_ME_WITH_YOUR_SHARED_TOKEN'); // EXACTEMENT le même que sur Render

// Limite FREE (visiteurs / non-connectés) : X requêtes / jour / IP
define('OLYMPEUS_FREE_DAILY_LIMIT', 5);

/** ========= B) SHORTCODE UI ========= */
add_shortcode('olympeus_ai', function () {
  // imprime le JS une seule fois si le shortcode existe sur la page
  add_action('wp_footer', 'olympeus_ai_print_inline_script', 99);

  ob_start(); ?>
  <div id="olympeus-ai" style="max-width:900px;margin:40px auto;padding:24px;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.08);">
    <h2 style="margin:0 0 6px 0;">Olympeus AI</h2>
    <div style="opacity:.7;margin-bottom:16px;">Assistant intelligent</div>

    <div id="olympeus-messages" style="min-height:120px;padding:12px;border:1px solid #eee;border-radius:10px;margin-bottom:12px;overflow:auto;"></div>

    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
      <label style="display:flex;gap:6px;align-items:center;font-size:14px;">
        <input type="checkbox" id="olympeus-web" />
        Recherche web
      </label>
      <label style="display:flex;gap:6px;align-items:center;font-size:14px;">
        <input type="checkbox" id="olympeus-expert" />
        Mode expert
      </label>
    </div>

    <form id="olympeus-form" style="display:flex;gap:10px;">
      <input id="olympeus-input" type="text" placeholder="Écris ton message..." style="flex:1;padding:10px 12px;border:1px solid #ddd;border-radius:10px;" />
      <button type="submit" style="padding:10px 16px;border:0;border-radius:10px;background:#1e73be;color:#fff;cursor:pointer;">Envoyer</button>
    </form>
  </div>
  <?php
  return ob_get_clean();
});

/** ========= C) REST ROUTE (PUBLIC) ========= */
add_action('rest_api_init', function () {
  register_rest_route('olympeus/v1', '/chat', [
    'methods'  => 'POST',
    'callback' => 'olympeus_ai_rest_chat',
    // PUBLIC : on gère la sécurité nous-mêmes via token
    'permission_callback' => '__return_true',
  ]);
});

function olympeus_ai_rest_chat(WP_REST_Request $request) {

  /** 1) Sécurité: token obligatoire (pour éviter qu'on appelle ton WP endpoint depuis n'importe où) */
  $client_token = $request->get_header('x-olympeus-token');
  if (!$client_token) $client_token = $request->get_header('X-Olympeus-Token');

  if (!$client_token || $client_token !== OLYMPEUS_SHARED_TOKEN) {
    return new WP_REST_Response(['ok' => false, 'error' => 'unauthorized'], 401);
  }

  /** 2) Limite FREE : si visiteur (non connecté), on limite par IP */
  if (!is_user_logged_in()) {
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '0.0.0.0';
    $day = gmdate('Ymd');
    $key = 'olympeus_rl_' . md5($ip . '_' . $day);

    $count = (int) get_transient($key);

    if ($count >= OLYMPEUS_FREE_DAILY_LIMIT) {
      return new WP_REST_Response([
        'ok' => false,
        'error' => 'free_limit_reached',
        'limit' => OLYMPEUS_FREE_DAILY_LIMIT
      ], 402);
    }

    // on incrémente
    set_transient($key, $count + 1, DAY_IN_SECONDS);
  }

  /** 3) Payload JSON */
  $body = $request->get_json_params();
  if (!is_array($body) || empty($body['message'])) {
    return new WP_REST_Response(['ok' => false, 'error' => 'missing_message'], 400);
  }

  /** 4) Proxy vers Render */
  $headers = [
    'Content-Type' => 'application/json',
    // on transmet le token au backend Render (il doit le vérifier aussi)
    'x-olympeus-token' => OLYMPEUS_SHARED_TOKEN,
  ];

  $resp = wp_remote_post(OLYMPEUS_RENDER_URL, [
    'headers' => $headers,
    'body'    => wp_json_encode($body),
    'timeout' => 60,
  ]);

  if (is_wp_error($resp)) {
    return new WP_REST_Response(['ok' => false, 'error' => $resp->get_error_message()], 502);
  }

  $status = wp_remote_retrieve_response_code($resp);
  $text   = wp_remote_retrieve_body($resp);

  // si c'est du JSON, on renvoie du JSON, sinon texte brut
  $json = json_decode($text, true);
  if (json_last_error() === JSON_ERROR_NONE) {
    return new WP_REST_Response($json, $status ?: 200);
  }

  return new WP_REST_Response([
    'ok' => ($status >= 200 && $status < 300),
    'raw' => $text
  ], $status ?: 200);
}

/** ========= D) JS INLINE (FRONT) ========= */
function olympeus_ai_print_inline_script() {
  static $printed = false;
  if ($printed) return;
  $printed = true;

  $rest_url = esc_url_raw( rest_url('olympeus/v1/chat') );
  $token    = OLYMPEUS_SHARED_TOKEN;
  ?>
  <script>
  (function(){
    const REST_URL = <?php echo json_encode($rest_url); ?>;
    const TOKEN    = <?php echo json_encode($token); ?>;

    const root = document.getElementById('olympeus-ai');
    if(!root) return;

    const messagesEl = document.getElementById('olympeus-messages');
    const form = document.getElementById('olympeus-form');
    const input = document.getElementById('olympeus-input');
    const webCb = document.getElementById('olympeus-web');
    const expertCb = document.getElementById('olympeus-expert');

    function addMsg(text, who){
      const div = document.createElement('div');
      div.style.margin = '8px 0';
      div.innerHTML = `<b>${who === 'user' ? 'Vous' : 'Olympeus'} :</b> ${String(text)}`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendMessage(message){
      const payload = {
        message,
        expert: !!(expertCb && expertCb.checked),
        web: { enabled: !!(webCb && webCb.checked), query: "" }
      };

      const res = await fetch(REST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Olympeus-Token": TOKEN
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => null);
      if(!res.ok){
        const err = (data && (data.error || data.message)) ? (data.error || data.message) : ("HTTP " + res.status);
        throw new Error(err);
      }

      // compat: selon ton backend
      if (data && data.answer) return data.answer;
      if (data && data.response) return data.response;
      if (data && data.message) return data.message;
      return "Réponse vide";
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = (input.value || "").trim();
      if(!msg) return;

      input.value = "";
      addMsg(msg, "user");

      try{
        const answer = await sendMessage(msg);
        addMsg(answer, "assistant");
      }catch(err){
        addMsg("✗ " + err.message, "assistant");
      }
    });
  })();
  </script>
  <?php
}
