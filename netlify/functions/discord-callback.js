// netlify/functions/discord-callback.js
// Discord redirige ici après autorisation, avec un "code" temporaire.
// On l'échange contre un token, on récupère l'identité réelle,
// puis on renvoie la personne vers le site avec ses infos.

exports.handler = async (event) => {
  const code = event.queryStringParameters && event.queryStringParameters.code;
  if (!code) {
    return { statusCode: 400, body: 'Code Discord manquant.' };
  }

  try {
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

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;

    // Comparaison avec TON id Discord (variable d'env OWNER_DISCORD_ID) —
    // un id Discord ne peut pas être usurpé en tapant juste un pseudo.
    const isOwner = user.id === process.env.OWNER_DISCORD_ID;

    const payload = encodeURIComponent(JSON.stringify({
      discordId: user.id,
      username: user.username,
      avatar: avatarUrl,
      isOwner,
    }));

    return {
      statusCode: 302,
      headers: {
        Location: `${process.env.FRONTEND_URL}/?discordAuth=${payload}`,
      },
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Échec de l'authentification Discord." };
  }
};
