// netlify/functions/discord-auth.js
// Redirige le visiteur vers l'écran d'autorisation Discord.
// Scope "guilds" en plus de "identify" pour pouvoir ensuite lister
// les serveurs où l'utilisateur est admin (nécessaire pour publier une pub).

exports.handler = async () => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://discord.com/api/oauth2/authorize?${params.toString()}`,
    },
  };
};
