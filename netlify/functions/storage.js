// netlify/functions/storage.js

const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");

const DATA_STORE = "dezoxtube-data";
const SESSION_STORE = "dezoxtube-sessions";

const MODERATOR_ID = "1543536698913456162";

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

function getCookies(event) {
  const header = event.headers?.cookie || event.headers?.Cookie || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const index = part.indexOf("=");

    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

async function getSession(event) {
  const cookies = getCookies(event);
  const sessionId = cookies.dezox_session;

  if (!sessionId) return null;

  const store = getStore(SESSION_STORE);

  const session = await store.get(sessionId, {
    type: "json",
  });

  if (!session) return null;

  if (session.expiresAt && Date.now() > session.expiresAt) {
    await store.delete(sessionId);
    return null;
  }

  return session;
}

async function requireSession(event) {
  const session = await getSession(event);

  if (!session) {
    throw new Error("AUTH_REQUIRED");
  }

  return session;
}

async function requireModerator(event) {
  const session = await requireSession(event);

  if (session.discordId !== MODERATOR_ID) {
    throw new Error("MODERATOR_REQUIRED");
  }

  return session;
}

async function readData(key, fallback) {
  const store = getStore(DATA_STORE);

  const value = await store.get(key, {
    type: "json",
  });

  return value ?? fallback;
}

async function writeData(key, value) {
  const store = getStore(DATA_STORE);

  await store.setJSON(key, value);
}

function now() {
  return new Date().toISOString();
}

function createId(prefix = "") {
  return `${prefix}${crypto.randomUUID()}`;
}

function getBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function isBanActive(ban) {
  if (!ban) return false;

  if (!ban.expiresAt) {
    return true;
  }

  return Date.now() < new Date(ban.expiresAt).getTime();
}

async function getBan(discordId) {
  const bans = await readData("bans", {});

  const ban = bans[discordId];

  if (!ban) {
    return null;
  }

  if (!isBanActive(ban)) {
    delete bans[discordId];
    await writeData("bans", bans);
    return null;
  }

  return ban;
}

async function createModerationLog({
  moderatorId,
  moderatorUsername,
  action,
  targetDiscordId,
  targetUsername,
  adId,
  reason,
  duration,
}) {
  const logs = await readData("moderationLogs", []);

  logs.unshift({
    id: createId("log_"),
    moderatorId,
    moderatorUsername,
    action,
    targetDiscordId: targetDiscordId || null,
    targetUsername: targetUsername || null,
    adId: adId || null,
    reason: reason || "",
    duration: duration || null,
    createdAt: now(),
  });

  // On garde les 1000 derniers logs.
  await writeData(
    "moderationLogs",
    logs.slice(0, 1000)
  );
}

async function handlePublic() {
  const ads = await readData("ads", []);
  const comments = await readData("comments", []);
  const votes = await readData("votes", {});

  return json(200, {
    ads,
    comments,
    votes,
  });
}

async function handleMe(event) {
  const session = await getSession(event);

  if (!session) {
    return json(200, {
      authenticated: false,
      user: null,
    });
  }

  return json(200, {
    authenticated: true,
    user: {
      discordId: session.discordId,
      username: session.username,
      avatar: session.avatar,
      channelName: session.channelName,
      guilds: session.guilds || [],
    },
  });
}

async function handleCreateAd(event, body, session) {
  const ban = await getBan(session.discordId);

  if (ban) {
    return json(403, {
      error: "USER_BANNED",
      ban,
    });
  }

  const {
    guildId,
    guildName,
    guildIcon,
    description,
    tags,
    invite,
    image,
  } = body;

  if (!guildId) {
    return json(400, {
      error: "GUILD_REQUIRED",
    });
  }

  // Vérification serveur :
  // l'utilisateur doit réellement avoir accès
  // au serveur Discord concerné.
  const guild = (session.guilds || []).find(
    (g) => String(g.id) === String(guildId)
  );

  if (!guild) {
    return json(403, {
      error: "GUILD_NOT_ALLOWED",
    });
  }

  const ads = await readData("ads", []);

  const existingIndex = ads.findIndex(
    (ad) =>
      String(ad.guildId) === String(guildId) &&
      String(ad.authorDiscordId) === String(session.discordId)
  );

  const ad = {
    id:
      existingIndex >= 0
        ? ads[existingIndex].id
        : createId("ad_"),

    guildId,
    guildName: guildName || guild.name || "",
    guildIcon: guildIcon || guild.icon || "",

    description: String(description || "").slice(0, 2000),

    tags: Array.isArray(tags)
      ? tags.slice(0, 10)
      : [],

    invite: String(invite || "").slice(0, 500),
    image: String(image || "").slice(0, 1000),

    authorDiscordId: session.discordId,
    authorUsername: session.username,

    createdAt:
      existingIndex >= 0
        ? ads[existingIndex].createdAt
        : now(),

    updatedAt: now(),

    votes:
      existingIndex >= 0
        ? Number(ads[existingIndex].votes || 0)
        : 0,
  };

  if (existingIndex >= 0) {
    ads[existingIndex] = {
      ...ads[existingIndex],
      ...ad,
    };
  } else {
    ads.push(ad);
  }

  await writeData("ads", ads);

  return json(200, {
    success: true,
    ad,
  });
}

async function handleDeleteAd(event, body, session) {
  const adId = body.id;

  if (!adId) {
    return json(400, {
      error: "AD_ID_REQUIRED",
    });
  }

  const ads = await readData("ads", []);

  const ad = ads.find(
    (item) => String(item.id) === String(adId)
  );

  if (!ad) {
    return json(404, {
      error: "AD_NOT_FOUND",
    });
  }

  const isOwner =
    String(ad.authorDiscordId) ===
    String(session.discordId);

  const isModerator =
    String(session.discordId) === MODERATOR_ID;

  if (!isOwner && !isModerator) {
    return json(403, {
      error: "NOT_ALLOWED",
    });
  }

  const newAds = ads.filter(
    (item) => String(item.id) !== String(adId)
  );

  await writeData("ads", newAds);

  if (isModerator && !isOwner) {
    await createModerationLog({
      moderatorId: session.discordId,
      moderatorUsername: session.username,
      action: "DELETE_AD",
      targetDiscordId: ad.authorDiscordId,
      targetUsername: ad.authorUsername,
      adId: ad.id,
      reason: body.reason || "",
    });
  }

  return json(200, {
    success: true,
  });
}

async function handleVote(event, body, session) {
  const adId = body.adId;

  if (!adId) {
    return json(400, {
      error: "AD_ID_REQUIRED",
    });
  }

  const ads = await readData("ads", []);

  const ad = ads.find(
    (item) => String(item.id) === String(adId)
  );

  if (!ad) {
    return json(404, {
      error: "AD_NOT_FOUND",
    });
  }

  const votes = await readData("votes", {});

  if (!votes[adId]) {
    votes[adId] = {};
  }

  const userId = session.discordId;

  if (votes[adId][userId]) {
    delete votes[adId][userId];
  } else {
    votes[adId][userId] = true;
  }

  const count = Object.keys(votes[adId]).length;

  ad.votes = count;

  await writeData("votes", votes);
  await writeData("ads", ads);

  return json(200, {
    success: true,
    voted: !!votes[adId][userId],
    votes: count,
  });
}

async function handleAddComment(event, body, session) {
  const adId = body.adId;

  if (!adId) {
    return json(400, {
      error: "AD_ID_REQUIRED",
    });
  }

  const ads = await readData("ads", []);

  const adExists = ads.some(
    (ad) => String(ad.id) === String(adId)
  );

  if (!adExists) {
    return json(404, {
      error: "AD_NOT_FOUND",
    });
  }

  const text = String(body.text || "").trim();

  if (!text) {
    return json(400, {
      error: "COMMENT_EMPTY",
    });
  }

  if (text.length > 1000) {
    return json(400, {
      error: "COMMENT_TOO_LONG",
    });
  }

  const comments = await readData("comments", []);

  const comment = {
    id: createId("comment_"),
    adId,
    text,
    authorDiscordId: session.discordId,
    authorUsername: session.username,
    authorAvatar: session.avatar,
    createdAt: now(),
  };

  comments.push(comment);

  await writeData("comments", comments);

  return json(200, {
    success: true,
    comment,
  });
}

async function handleDeleteComment(event, body, session) {
  const commentId = body.id;

  const comments = await readData("comments", []);

  const comment = comments.find(
    (item) => String(item.id) === String(commentId)
  );

  if (!comment) {
    return json(404, {
      error: "COMMENT_NOT_FOUND",
    });
  }

  const isOwner =
    String(comment.authorDiscordId) ===
    String(session.discordId);

  const isModerator =
    String(session.discordId) === MODERATOR_ID;

  if (!isOwner && !isModerator) {
    return json(403, {
      error: "NOT_ALLOWED",
    });
  }

  await writeData(
    "comments",
    comments.filter(
      (item) => String(item.id) !== String(commentId)
    )
  );

  return json(200, {
    success: true,
  });
}

async function handleModeration(event) {
  const session = await requireModerator(event);

  const ads = await readData("ads", []);
  const bans = await readData("bans", {});
  const logs = await readData("moderationLogs", []);

  const activeBans = Object.values(bans).filter(
    isBanActive
  );

  return json(200, {
    moderator: {
      discordId: session.discordId,
      username: session.username,
    },

    ads,

    bans: activeBans,

    logs: logs.slice(0, 200),

    stats: {
      ads: ads.length,
      usersBanned: activeBans.length,
      logs: logs.length,

      users: [
        ...new Set(
          ads
            .map((ad) => ad.authorDiscordId)
            .filter(Boolean)
        ),
      ].length,
    },
  });
}

async function handleBan(event, body) {
  const moderator = await requireModerator(event);

  const discordId = String(body.discordId || "").trim();

  if (!discordId) {
    return json(400, {
      error: "DISCORD_ID_REQUIRED",
    });
  }

  if (discordId === MODERATOR_ID) {
    return json(403, {
      error: "CANNOT_BAN_MODERATOR",
    });
  }

  const duration = body.duration || "permanent";

  const durations = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    permanent: null,
  };

  if (!Object.prototype.hasOwnProperty.call(durations, duration)) {
    return json(400, {
      error: "INVALID_DURATION",
    });
  }

  const bans = await readData("bans", {});

  const expiresAt =
    durations[duration] === null
      ? null
      : new Date(
          Date.now() + durations[duration]
        ).toISOString();

  const ban = {
    discordId,
    username: body.username || "",
    reason: String(body.reason || "").slice(0, 1000),
    duration,
    createdAt: now(),
    expiresAt,
    bannedBy: moderator.discordId,
    bannedByUsername: moderator.username,
  };

  bans[discordId] = ban;

  await writeData("bans", bans);

  await createModerationLog({
    moderatorId: moderator.discordId,
    moderatorUsername: moderator.username,
    action: "BAN",
    targetDiscordId: discordId,
    targetUsername: body.username || "",
    reason: ban.reason,
    duration,
  });

  return json(200, {
    success: true,
    ban,
  });
}

async function handleUnban(event, body) {
  const moderator = await requireModerator(event);

  const discordId = String(body.discordId || "").trim();

  if (!discordId) {
    return json(400, {
      error: "DISCORD_ID_REQUIRED",
    });
  }

  const bans = await readData("bans", {});

  const existed = !!bans[discordId];

  delete bans[discordId];

  await writeData("bans", bans);

  if (existed) {
    await createModerationLog({
      moderatorId: moderator.discordId,
      moderatorUsername: moderator.username,
      action: "UNBAN",
      targetDiscordId: discordId,
    });
  }

  return json(200, {
    success: true,
  });
}

async function handleAction(event, body, session) {
  switch (body.action) {
    case "createAd":
    case "updateAd":
      return handleCreateAd(event, body, session);

    case "deleteAd":
      return handleDeleteAd(event, body, session);

    case "vote":
      return handleVote(event, body, session);

    case "addComment":
      return handleAddComment(event, body, session);

    case "deleteComment":
      return handleDeleteComment(event, body, session);

    case "ban":
      return handleBan(event, body);

    case "unban":
      return handleUnban(event, body);

    default:
      return json(400, {
        error: "UNKNOWN_ACTION",
      });
  }
}

exports.handler = async (event) => {
  try {
    // Nécessaire pour certains environnements Lambda/Netlify.
    try {
      await connectLambda(event);
    } catch {
      // Certaines versions/environnements n'en ont pas besoin.
    }

    const method = event.httpMethod || "GET";

    if (method === "GET") {
      const action =
        event.queryStringParameters?.action || "public";

      if (action === "public") {
        return handlePublic();
      }

      if (action === "me") {
        return handleMe(event);
      }

      if (action === "moderation") {
        return handleModeration(event);
      }

      if (action === "ban") {
        const discordId =
          event.queryStringParameters?.discordId;

        if (!discordId) {
          return json(400, {
            error: "DISCORD_ID_REQUIRED",
          });
        }

        const ban = await getBan(discordId);

        return json(200, {
          banned: !!ban,
          ban,
        });
      }

      return json(400, {
        error: "UNKNOWN_ACTION",
      });
    }

    if (method === "POST") {
      const body = getBody(event);

      const session = await requireSession(event);

      return handleAction(event, body, session);
    }

    return json(405, {
      error: "METHOD_NOT_ALLOWED",
    });
  } catch (error) {
    console.error("Storage error:", error);

    if (error.message === "AUTH_REQUIRED") {
      return json(401, {
        error: "AUTH_REQUIRED",
      });
    }

    if (error.message === "MODERATOR_REQUIRED") {
      return json(403, {
        error: "MODERATOR_REQUIRED",
      });
    }

    if (error.message === "INVALID_JSON") {
      return json(400, {
        error: "INVALID_JSON",
      });
    }

    return json(500, {
      error: "SERVER_ERROR",
      message: error.message || "Erreur serveur.",
    });
  }
};
