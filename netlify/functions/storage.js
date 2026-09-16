const { getStore, connectLambda } = require('@netlify/blobs');

const MODERATOR_ID = '1543536698913456162';

const DATA_STORE = 'dezoxtube-data';
const SESSION_STORE = 'dezoxtube-sessions';

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

function getCookie(event, name) {
  const cookies = event.headers?.cookie || event.headers?.Cookie || '';

  for (const part of cookies.split(';')) {
    const [key, ...value] = part.trim().split('=');

    if (key === name) {
      return decodeURIComponent(value.join('='));
    }
  }

  return null;
}

async function getSession(event) {
  const sessionId = getCookie(event, 'dezox_session');

  if (!sessionId) {
    return null;
  }

  const store = getStore(SESSION_STORE);

  const session = await store.get(`session:${sessionId}`, {
    type: 'json',
    consistency: 'strong',
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt && Date.now() > session.expiresAt) {
    await store.delete(`session:${sessionId}`);
    return null;
  }

  return session;
}

async function getData() {
  const store = getStore(DATA_STORE);

  const data = await store.get('database', {
    type: 'json',
    consistency: 'strong',
  });

  return {
    ads: Array.isArray(data?.ads) ? data.ads : [],
    comments: Array.isArray(data?.comments) ? data.comments : [],
    votes: data?.votes && typeof data.votes === 'object' ? data.votes : {},
    bans: Array.isArray(data?.bans) ? data.bans : [],
    moderationLogs: Array.isArray(data?.moderationLogs)
      ? data.moderationLogs
      : [],
  };
}

async function saveData(data) {
  const store = getStore(DATA_STORE);

  await store.setJSON('database', {
    ads: data.ads || [],
    comments: data.comments || [],
    votes: data.votes || {},
    bans: data.bans || [],
    moderationLogs: data.moderationLogs || [],
  });
}

function isModerator(session) {
  return !!session && session.discordId === MODERATOR_ID;
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .slice(0, maxLength);
}

function createId(prefix = '') {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getActiveBan(data, discordId) {
  const now = Date.now();

  return data.bans.find((ban) => {
    if (ban.discordId !== discordId) return false;

    if (ban.expiresAt === null) {
      return true;
    }

    return Number(ban.expiresAt) > now;
  }) || null;
}

function addModerationLog(data, session, action, targetDiscordId, details = {}) {
  data.moderationLogs.unshift({
    id: createId('log-'),
    action,
    moderatorDiscordId: session.discordId,
    moderatorUsername: session.username || 'Modérateur',
    targetDiscordId: targetDiscordId || null,
    details,
    createdAt: Date.now(),
  });

  data.moderationLogs = data.moderationLogs.slice(0, 1000);
}

exports.handler = async (event) => {
  try {
    /*
     * Netlify Blobs fonctionne avec les Functions.
     * Cette connexion est utile notamment avec l'environnement Lambda.
     */
    try {
      connectLambda(event);
    } catch {
      // Pas bloquant si l'environnement n'en a pas besoin.
    }

    const method = event.httpMethod || 'GET';
    const session = await getSession(event);

    /*
     * =========================
     * GET
     * =========================
     */
    if (method === 'GET') {
      const data = await getData();

      const action =
        event.queryStringParameters?.action || 'public';

      /*
       * Données publiques :
       * - pubs
       * - commentaires
       * - votes
       *
       * Les bans et logs ne sont jamais envoyés publiquement.
       */
      if (action === 'public') {
        return json(200, {
          ads: data.ads,
          comments: data.comments,
          votes: data.votes,
          user: session
            ? {
                discordId: session.discordId,
                username: session.username,
                avatar: session.avatar,
                channelName: session.channelName,
                guilds: session.guilds || [],
              }
            : null,
        });
      }

      /*
       * Informations du compte connecté.
       */
      if (action === 'me') {
        return json(200, {
          user: session
            ? {
                discordId: session.discordId,
                username: session.username,
                avatar: session.avatar,
                channelName: session.channelName,
                guilds: session.guilds || [],
              }
            : null,
        });
      }

      /*
       * =========================
       * MODÉRATION
       * =========================
       */
      if (action === 'moderation') {
        if (!isModerator(session)) {
          return json(403, {
            error: 'Accès refusé.',
          });
        }

        const users = {};

        for (const ad of data.ads) {
          if (!ad.authorDiscordId) continue;

          if (!users[ad.authorDiscordId]) {
            users[ad.authorDiscordId] = {
              discordId: ad.authorDiscordId,
              ads: 0,
            };
          }

          users[ad.authorDiscordId].ads++;
        }

        return json(200, {
          ads: data.ads,
          bans: data.bans,
          moderationLogs: data.moderationLogs,
          stats: {
            totalAds: data.ads.length,
            totalBans: data.bans.length,
            totalUsers: Object.keys(users).length,
            totalComments: data.comments.length,
          },
        });
      }

      return json(400, {
        error: 'Action GET inconnue.',
      });
    }

    /*
     * =========================
     * POST
     * =========================
     */
    if (method === 'POST') {
      if (!session) {
        return json(401, {
          error: 'Tu dois être connecté avec Discord.',
        });
      }

      let body;

      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return json(400, {
          error: 'Données invalides.',
        });
      }

      const action = body.action;
      const data = await getData();

      /*
       * =========================
       * CRÉER UNE PUB
       * =========================
       */
      if (action === 'createAd') {
        const activeBan = getActiveBan(
          data,
          session.discordId
        );

        if (activeBan) {
          return json(403, {
            error:
              activeBan.expiresAt === null
                ? 'Ton compte est banni définitivement de la publication.'
                : `Tu es banni de la publication jusqu'au ${new Date(
                    activeBan.expiresAt
                  ).toLocaleString('fr-FR')}.`,
            ban: activeBan,
          });
        }

        const guildId = cleanText(body.guildId, 100);

        const guild = (session.guilds || []).find(
          (g) => String(g.id) === guildId
        );

        if (!guild) {
          return json(403, {
            error:
              'Tu ne peux pas publier ce serveur Discord.',
          });
        }

        const name = cleanText(body.name, 100);
        const description = cleanText(body.description, 1000);
        const invite = cleanText(body.invite, 500);
        const icon = cleanText(body.icon, 1000);
        const banner = cleanText(body.banner, 1000);
        const tags = Array.isArray(body.tags)
          ? body.tags
              .map((tag) => cleanText(String(tag), 40))
              .filter(Boolean)
              .slice(0, 10)
          : [];

        if (!name) {
          return json(400, {
            error: 'Nom du serveur manquant.',
          });
        }

        const ad = {
          id: createId('ad-'),
          guildId,
          name,
          description,
          invite,
          icon,
          banner,
          tags,

          /*
           * IMPORTANT :
           * L'auteur est déterminé par la session Discord.
           * On ne fait PAS confiance à body.authorDiscordId.
           */
          authorDiscordId: session.discordId,
          authorUsername: session.username || '',

          votes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bumpedAt: Date.now(),
        };

        data.ads.unshift(ad);

        await saveData(data);

        return json(201, {
          success: true,
          ad,
        });
      }

      /*
       * =========================
       * MODIFIER UNE PUB
       * =========================
       */
      if (action === 'updateAd') {
        const id = cleanText(body.id, 150);

        const ad = data.ads.find(
          (item) => item.id === id
        );

        if (!ad) {
          return json(404, {
            error: 'Pub introuvable.',
          });
        }

        if (ad.authorDiscordId !== session.discordId) {
          return json(403, {
            error:
              'Tu ne peux modifier que tes propres pubs.',
          });
        }

        if (body.name !== undefined) {
          ad.name = cleanText(body.name, 100);
        }

        if (body.description !== undefined) {
          ad.description = cleanText(
            body.description,
            1000
          );
        }

        if (body.invite !== undefined) {
          ad.invite = cleanText(body.invite, 500);
        }

        if (body.icon !== undefined) {
          ad.icon = cleanText(body.icon, 1000);
        }

        if (body.banner !== undefined) {
          ad.banner = cleanText(body.banner, 1000);
        }

        if (Array.isArray(body.tags)) {
          ad.tags = body.tags
            .map((tag) => cleanText(String(tag), 40))
            .filter(Boolean)
            .slice(0, 10);
        }

        ad.updatedAt = Date.now();

        await saveData(data);

        return json(200, {
          success: true,
          ad,
        });
      }

      /*
       * =========================
       * SUPPRIMER UNE PUB
       * =========================
       */
      if (action === 'deleteAd') {
        const id = cleanText(body.id, 150);

        const ad = data.ads.find(
          (item) => item.id === id
        );

        if (!ad) {
          return json(404, {
            error: 'Pub introuvable.',
          });
        }

        const moderator = isModerator(session);

        if (
          !moderator &&
          ad.authorDiscordId !== session.discordId
        ) {
          return json(403, {
            error:
              'Tu ne peux supprimer que tes propres pubs.',
          });
        }

        data.ads = data.ads.filter(
          (item) => item.id !== id
        );

        /*
         * Si un modérateur supprime une pub,
         * on garde une trace dans le journal.
         */
        if (moderator && ad.authorDiscordId !== session.discordId) {
          addModerationLog(
            data,
            session,
            'DELETE_AD',
            ad.authorDiscordId,
            {
              adId: ad.id,
              adName: ad.name,
            }
          );
        }

        await saveData(data);

        return json(200, {
          success: true,
        });
      }

      /*
       * =========================
       * BUMP
       * =========================
       */
      if (action === 'bumpAd') {
        const id = cleanText(body.id, 150);

        const ad = data.ads.find(
          (item) => item.id === id
        );

        if (!ad) {
          return json(404, {
            error: 'Pub introuvable.',
          });
        }

        if (ad.authorDiscordId !== session.discordId) {
          return json(403, {
            error:
              'Seul le créateur peut bumper cette pub.',
          });
        }

        ad.bumpedAt = Date.now();

        await saveData(data);

        return json(200, {
          success: true,
          ad,
        });
      }

      /*
       * =========================
       * VOTE
       * =========================
       */
      if (action === 'toggleVote') {
        const id = cleanText(body.id, 150);

        const ad = data.ads.find(
          (item) => item.id === id
        );

        if (!ad) {
          return json(404, {
            error: 'Pub introuvable.',
          });
        }

        if (!data.votes[id]) {
          data.votes[id] = [];
        }

        const voters = data.votes[id];

        const index = voters.indexOf(
          session.discordId
        );

        let voted;

        if (index >= 0) {
          voters.splice(index, 1);
          voted = false;
        } else {
          voters.push(session.discordId);
          voted = true;
        }

        ad.votes = voters.length;

        await saveData(data);

        return json(200, {
          success: true,
          voted,
          votes: ad.votes,
        });
      }

      /*
       * =========================
       * AJOUTER COMMENTAIRE
       * =========================
       */
      if (action === 'createComment') {
        const adId = cleanText(body.adId, 150);
        const text = cleanText(body.text, 1000);

        const ad = data.ads.find(
          (item) => item.id === adId
        );

        if (!ad) {
          return json(404, {
            error: 'Pub introuvable.',
          });
        }

        if (!text) {
          return json(400, {
            error: 'Commentaire vide.',
          });
        }

        const comment = {
          id: createId('comment-'),
          adId,
          text,
          authorDiscordId: session.discordId,
          authorUsername: session.username || '',
          createdAt: Date.now(),
        };

        data.comments.push(comment);

        await saveData(data);

        return json(201, {
          success: true,
          comment,
        });
      }

      /*
       * =========================
       * SUPPRIMER COMMENTAIRE
       * =========================
       */
      if (action === 'deleteComment') {
        const id = cleanText(body.id, 150);

        const comment = data.comments.find(
          (item) => item.id === id
        );

        if (!comment) {
          return json(404, {
            error: 'Commentaire introuvable.',
          });
        }

        if (
          comment.authorDiscordId !== session.discordId &&
          !isModerator(session)
        ) {
          return json(403, {
            error:
              'Tu ne peux supprimer que tes propres commentaires.',
          });
        }

        data.comments = data.comments.filter(
          (item) => item.id !== id
        );

        await saveData(data);

        return json(200, {
          success: true,
        });
      }

      /*
       * =========================
       * MODÉRATION : BAN
       * =========================
       */
      if (action === 'banUser') {
        if (!isModerator(session)) {
          return json(403, {
            error: 'Accès modération refusé.',
          });
        }

        const discordId = cleanText(
          body.discordId,
          100
        );

        if (!discordId) {
          return json(400, {
            error: 'Discord ID manquant.',
          });
        }

        if (discordId === MODERATOR_ID) {
          return json(400, {
            error:
              'Le propriétaire ne peut pas être banni.',
          });
        }

        const duration = cleanText(
          body.duration,
          20
        );

        const durations = {
          '1h': 60 * 60 * 1000,
          '24h': 24 * 60 * 60 * 1000,
          '7j': 7 * 24 * 60 * 60 * 1000,
          '30j': 30 * 24 * 60 * 60 * 1000,
          permanent: null,
        };

        if (!(duration in durations)) {
          return json(400, {
            error: 'Durée de ban invalide.',
          });
        }

        const reason =
          cleanText(body.reason, 500) ||
          'Aucune raison indiquée';

        /*
         * Remplace un éventuel ancien ban.
         */
        data.bans = data.bans.filter(
          (ban) => ban.discordId !== discordId
        );

        const expiresAt =
          durations[duration] === null
            ? null
            : Date.now() + durations[duration];

        const ban = {
          id: createId('ban-'),
          discordId,
          expiresAt,
          reason,
          bannedBy: session.discordId,
          bannedByUsername:
            session.username || '',
          createdAt: Date.now(),
        };

        data.bans.push(ban);

        addModerationLog(
          data,
          session,
          'BAN_USER',
          discordId,
          {
            duration,
            reason,
            expiresAt,
          }
        );

        await saveData(data);

        return json(200, {
          success: true,
          ban,
        });
      }

      /*
       * =========================
       * MODÉRATION : UNBAN
       * =========================
       */
      if (action === 'unbanUser') {
        if (!isModerator(session)) {
          return json(403, {
            error: 'Accès modération refusé.',
          });
        }

        const discordId = cleanText(
          body.discordId,
          100
        );

        const existed = data.bans.some(
          (ban) => ban.discordId === discordId
        );

        data.bans = data.bans.filter(
          (ban) => ban.discordId !== discordId
        );

        if (existed) {
          addModerationLog(
            data,
            session,
            'UNBAN_USER',
            discordId
          );
        }

        await saveData(data);

        return json(200, {
          success: true,
        });
      }

      /*
       * =========================
       * NETTOYAGE DES BANS EXPIRÉS
       * =========================
       */
      if (action === 'cleanupBans') {
        if (!isModerator(session)) {
          return json(403, {
            error: 'Accès modération refusé.',
          });
        }

        const now = Date.now();

        data.bans = data.bans.filter(
          (ban) =>
            ban.expiresAt === null ||
            Number(ban.expiresAt) > now
        );

        await saveData(data);

        return json(200, {
          success: true,
          bans: data.bans,
        });
      }

      return json(400, {
        error: 'Action POST inconnue.',
      });
    }

    return json(405, {
      error: 'Méthode non autorisée.',
    });
  } catch (error) {
    console.error('DeZoxtube storage error:', error);

    return json(500, {
      error:
        'Erreur serveur. Consulte les logs Netlify.',
    });
  }
};
