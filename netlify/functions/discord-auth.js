// netlify/functions/discord-auth.js
// Redirige le visiteur vers l'écran d'autorisation Discord.
// Appelée quand on clique sur "Se connecter avec Discord" dans le site.

exports.handler = async () => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://discord.com/api/oauth2/authorize?${params.toString()}`,
    },
  };
};
