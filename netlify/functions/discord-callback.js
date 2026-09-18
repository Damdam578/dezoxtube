const {
  getStore,
  connectLambda,
} = require("@netlify/blobs");

const SESSION_STORE = "dezoxtube-sessions";

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://dezoxtube.netlify.app";

function response(
  statusCode,
  headers = {},
  body = ""
) {
  return {
    statusCode,
    headers,
    body,
  };
}

function redirect(url, cookie) {
  return response(
    302,
    {
      Location: url,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    }
  );
}

function createSessionId() {
  return (
    "sess_" +
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .slice(2) +
    Math.random()
      .toString(36)
      .slice(2)
  );
}

exports.handler = async (event) => {
  try {
    try {
      connectLambda(event);
    } catch {}

    const params =
      event.queryStringParameters || {};

    const code = params.code;

    if (!code) {
      return response(
        400,
        {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
        "Code Discord manquant."
      );
    }

    const clientId =
      process.env.DISCORD_CLIENT_ID;

    const clientSecret =
      process.env.DISCORD_CLIENT_SECRET;

    const redirectUri =
      process.env.DISCORD_REDIRECT_URI;

    if (
      !clientId ||
      !clientSecret ||
      !redirectUri
    ) {
      console.error(
        "Variables Discord manquantes."
      );

      return response(
        500,
        {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
        "Configuration Discord incomplète."
      );
    }

    /* =====================================================
       1. ÉCHANGE DU CODE CONTRE UN TOKEN DISCORD
    ===================================================== */

    const tokenResponse =
      await fetch(
        "https://discord.com/api/oauth2/token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
          },

          body:
            new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type:
                "authorization_code",
              code,
              redirect_uri:
                redirectUri,
            }).toString(),
        }
      );

    const tokenData =
      await tokenResponse.json();

    if (
      !tokenResponse.ok ||
      !tokenData.access_token
    ) {
      console.error(
        "Discord token error:",
        tokenData
      );

      return response(
        401,
        {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
        "Impossible de connecter ton compte Discord."
      );
    }

    const accessToken =
      tokenData.access_token;

    const refreshToken =
      tokenData.refresh_token ||
      null;

    const expiresIn =
      Number(
        tokenData.expires_in || 604800
      );

    /* =====================================================
       2. RÉCUPÉRATION DU COMPTE DISCORD
    ===================================================== */

    const userResponse =
      await fetch(
        "https://discord.com/api/users/@me",
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    const discordUser =
      await userResponse.json();

    if (
      !userResponse.ok ||
      !discordUser.id
    ) {
      console.error(
        "Discord user error:",
        discordUser
      );

      return response(
        401,
        {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
        "Impossible de récupérer ton compte Discord."
      );
    }

    /* =====================================================
       3. RÉCUPÉRATION DES SERVEURS DISCORD
    ===================================================== */

    const guildResponse =
      await fetch(
        "https://discord.com/api/users/@me/guilds",
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    let guilds = [];

    if (guildResponse.ok) {
      const allGuilds =
        await guildResponse.json();

      /*
        0x8  = ADMINISTRATOR
        0x20 = MANAGE_GUILD
      */

      guilds =
        Array.isArray(allGuilds)
          ? allGuilds
              .filter((guild) => {
                const permissions =
                  Number(
                    guild.permissions || 0
                  );

                return (
                  (permissions & 0x8) !== 0 ||
                  (permissions & 0x20) !== 0
                );
              })
              .map((guild) => ({
                id: guild.id,

                name:
                  guild.name || "",

                icon:
                  guild.icon || null,

                permissions:
                  String(
                    guild.permissions || "0"
                  ),
              }))
          : [];
    }

    /* =====================================================
       4. CRÉATION DE LA SESSION
    ===================================================== */

    const sessionId =
      createSessionId();

    const session = {
      discordId:
        String(discordUser.id),

      username:
        discordUser.global_name ||
        discordUser.username ||
        "",

      avatar:
        discordUser.avatar || null,

      guilds,

      accessToken,

      refreshToken,

      tokenExpiresAt:
        Date.now() +
        expiresIn * 1000,

      createdAt:
        Date.now(),

      expiresAt:
        Date.now() +
        30 * 24 * 60 * 60 * 1000,
    };

    const store =
      getStore(SESSION_STORE);

    await store.setJSON(
      sessionId,
      session
    );

    /* =====================================================
       5. COOKIE DE SESSION
    ===================================================== */

    const cookie =
      [
        `dezox_session=${encodeURIComponent(
          sessionId
        )}`,

        "Path=/",

        "Max-Age=2592000",

        "HttpOnly",

        "Secure",

        "SameSite=Lax",
      ].join("; ");

    /* =====================================================
       6. RETOUR SUR LE SITE
    ===================================================== */

    return redirect(
      FRONTEND_URL,
      cookie
    );
  } catch (error) {
    console.error(
      "discord-callback error:",
      error
    );

    return response(
      500,
      {
        "Content-Type":
          "text/plain; charset=utf-8",
      },
      "Erreur lors de la connexion Discord."
    );
  }
};
