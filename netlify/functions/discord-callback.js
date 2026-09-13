// netlify/functions/discord-callback.js
// Discord redirige ici après autorisation, avec un "code" temporaire.
// On l'échange contre un token, on récupère l'identité de l'utilisateur
// ET la liste de ses serveurs où il a les droits d'administration
// (nécessaire pour savoir quels serveurs il peut publier/bumper).

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

exports.handler = async (event) => {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  if (!code) {
    return { statusCode: 400, body: 'Code Discord manquant.' };
  }

  try {
    // 1. Échange le code contre un access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Échange de token échoué');
    const authHeader = { Authorization: `Bearer ${tokenData.access_token}` };

    // 2. Identité de l'utilisateur
    const userRes = await fetch('https://discord.com/api/users/@me', { headers: authHeader });
    const user = await userRes.json();

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;

    // 3. Liste des serveurs de l'utilisateur, filtrée sur ceux où il est
    //    propriétaire OU a la permission MANAGE_GUILD/ADMINISTRATOR.
    const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: authHeader });
    const allGuilds = await guildsRes.json();

    const manageable = (Array.isArray(allGuilds) ? allGuilds : []).filter((g) => {
      if (g.owner) return true;
      try {
        const perms = BigInt(g.permissions || '0');
        return (perms & MANAGE_GUILD) === MANAGE_GUILD || (perms & ADMINISTRATOR) === ADMINISTRATOR;
      } catch {
        return false;
      }
    }).map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : '',
      owner: !!g.owner,
    }));

    const payload = encodeURIComponent(JSON.stringify({
      discordId: user.id,
      username: user.username,
      avatar: avatarUrl,
      guilds: manageable,
    }));

    return {
      statusCode: 302,
      headers: { Location: `${process.env.FRONTEND_URL}/?discordAuth=${payload}` },
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Échec de l'authentification Discord." };
  }
};
