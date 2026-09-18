// netlify/functions/discord-callback.js

const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");

const SESSION_STORE = "dezoxtube-sessions";

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

exports.handler = async (event) => {
  try {
    try {
      await connectLambda(event);
    } catch {
      // Pas nécessaire dans certains environnements Netlify.
    }

    const code =
      event.queryStringParameters &&
      event.queryStringParameters.code;

    if (!code) {
      return {
        statusCode: 400,
        body: "Code Discord manquant.",
      };
    }

    // 1. Échange du code OAuth contre un token Discord
    const tokenRes = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret:
            process.env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri:
            process.env.DISCORD_REDIRECT_URI,
        }),
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error(
        "Discord token error:",
        tokenData
      );

      throw new Error(
        "Échange du token Discord échoué."
      );
    }

    const authHeader = {
      Authorization: `Bearer ${tokenData.access_token}`,
    };

    // 2. Récupération de l'utilisateur Discord
    const userRes = await fetch(
      "https://discord.com/api/users/@me",
      {
        headers: authHeader,
      }
    );

    const user = await userRes.json();

    if (!userRes.ok || !user.id) {
      throw new Error(
        "Impossible de récupérer le compte Discord."
      );
    }

    // 3. Avatar Discord
    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${
          Number(user.discriminator || 0) % 5
        }.png`;

    // 4. Récupération des serveurs Discord
    const guildsRes = await fetch(
      "https://discord.com/api/users/@me/guilds",
      {
        headers: authHeader,
      }
    );

    const allGuilds = await guildsRes.json();

    if (!guildsRes.ok) {
      throw new Error(
        "Impossible de récupérer les serveurs Discord."
      );
    }

    // 5. On garde uniquement les serveurs
    // sur lesquels l'utilisateur peut gérer le serveur.
    const manageable = (
      Array.isArray(allGuilds)
        ? allGuilds
        : []
    )
      .filter((guild) => {
        if (guild.owner) {
          return true;
        }

        try {
          const permissions = BigInt(
            guild.permissions || "0"
          );

          return (
            (permissions & MANAGE_GUILD) ===
              MANAGE_GUILD ||
            (permissions & ADMINISTRATOR) ===
              ADMINISTRATOR
          );
        } catch {
          return false;
        }
      })
      .map((guild) => ({
        id: guild.id,
        name: guild.name,

        icon: guild.icon
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
          : "",

        owner: !!guild.owner,
      }));

    // 6. Création d'une session aléatoire
    // L'identité Discord ne sera plus envoyée dans l'URL.
    const sessionId = crypto.randomUUID();

    const session = {
      discordId: user.id,
      username:
        user.global_name ||
        user.username ||
        "Utilisateur",

      avatar: avatarUrl,

      channelName:
        user.global_name ||
        user.username ||
        "Utilisateur",

      guilds: manageable,

      createdAt: Date.now(),

      // Session valable 30 jours.
      expiresAt:
        Date.now() +
        30 * 24 * 60 * 60 * 1000,
    };

    // 7. Sauvegarde de la session côté serveur
    const sessionStore =
      getStore(SESSION_STORE);

    await sessionStore.setJSON(
      sessionId,
      session
    );

    // 8. Cookie sécurisé
    const cookie =
      `dezox_session=${encodeURIComponent(sessionId)}; ` +
      "Path=/; " +
      "Max-Age=2592000; " +
      "HttpOnly; " +
      "Secure; " +
      "SameSite=Lax";

    // 9. Retour vers le site
    return {
      statusCode: 302,

      headers: {
        Location:
          process.env.FRONTEND_URL || "/",

        "Set-Cookie": cookie,

        "Cache-Control":
          "no-store",
      },
    };
  } catch (error) {
    console.error(
      "Discord callback error:",
      error
    );

    return {
      statusCode: 500,

      headers: {
        "Content-Type":
          "text/plain; charset=utf-8",
      },

      body:
        "Échec de l'authentification Discord.",
    };
  }
};
