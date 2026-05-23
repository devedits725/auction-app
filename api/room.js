// api/room.js — Vercel Serverless Function
// Stores room state in-memory (persists across requests within same instance)
// For production, swap the store with Vercel KV / Redis / PlanetScale

const rooms = {};

function autoSellIfExpired(room) {
  if (room.phase !== 'auction' || room.isSold || !room.timerStartedAt) return false;
  const duration = (room.settings?.timer || 30) * 1000;
  if (Date.now() - room.timerStartedAt < duration) return false;

  room.isSold = true;
  if (room.currentBidderId) {
    const winner = room.participants.find((p) => p.id === room.currentBidderId);
    if (winner) {
      winner.budget -= room.currentBid;
      winner.squad = winner.squad || [];
      const player = room.auctionQueue[room.currentIdx];
      winner.squad.push({
        name: player?.name,
        pos: player?.pos,
        price: room.currentBid,
      });
    }
    const player = room.auctionQueue[room.currentIdx];
    if (player) {
      player.sold = true;
      player.soldTo = winner?.name;
      player.soldPrice = room.currentBid;
    }
  }
  return true;
}

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Room code required' });

  // GET — fetch room state (also auto-sells when bid timer expires)
  if (req.method === 'GET') {
    if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
    autoSellIfExpired(rooms[code]);
    return res.status(200).json(rooms[code]);
  }

  // POST — create or update room state
  if (req.method === 'POST') {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'No body' });

    if (body.action === 'create') {
      if (rooms[code]) return res.status(409).json({ error: 'Room already exists' });
      rooms[code] = {
        code,
        createdAt: Date.now(),
        hostId: body.hostId,
        settings: body.settings,
        participants: body.participants,
        roster: body.roster,
        phase: 'lobby',
        auctionQueue: [],
        currentIdx: 0,
        currentBid: 0,
        currentBidderId: null,
        bidLog: [],
        isSold: false,
        timerStartedAt: null,
        timerDuration: body.settings?.timer || 30,
      };
      return res.status(200).json(rooms[code]);
    }

    if (body.action === 'join') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      const room = rooms[code];
      const p = body.participant;
      if (!p) return res.status(400).json({ error: 'Participant required' });
      const already = room.participants.find((x) => x.id === p.id);
      if (!already) {
        room.participants.push({
          ...p,
          budget: room.settings?.budget ?? 5000,
          squad: p.squad || [],
        });
      }
      return res.status(200).json(room);
    }

    if (body.action === 'update') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      rooms[code] = { ...rooms[code], ...body.patch };
      return res.status(200).json(rooms[code]);
    }

    if (body.action === 'bid') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      const room = rooms[code];
      if (room.isSold) return res.status(400).json({ error: 'Player already sold' });
      autoSellIfExpired(room);
      if (room.isSold) return res.status(200).json(room);

      const { bidderId, amount, bidderName } = body;
      const minBid = room.currentBid + (room.settings?.increment || 100);
      if (amount < minBid) {
        return res.status(400).json({ error: `Bid must be at least ${minBid}` });
      }
      const bidder = room.participants.find((p) => p.id === bidderId);
      if (!bidder) return res.status(400).json({ error: 'Bidder not found' });
      if (amount > bidder.budget) {
        return res.status(400).json({ error: 'Not enough budget' });
      }
      if ((bidder.squad || []).length >= (room.settings?.maxPlayers || 5)) {
        return res.status(400).json({ error: 'Team is full' });
      }

      room.currentBid = amount;
      room.currentBidderId = bidderId;
      room.bidLog.unshift({
        player: room.auctionQueue[room.currentIdx]?.name,
        bidder: bidderName,
        amount,
        ts: Date.now(),
      });
      room.timerStartedAt = Date.now();
      return res.status(200).json(room);
    }

    if (body.action === 'sell') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      const room = rooms[code];
      if (!room.isSold) autoSellIfExpired(room);
      return res.status(200).json(room);
    }

    if (body.action === 'next') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      const room = rooms[code];
      if (!room.isSold) autoSellIfExpired(room);
      room.currentIdx += 1;
      room.currentBid = room.auctionQueue[room.currentIdx]?.base || 0;
      room.currentBidderId = null;
      room.isSold = false;
      room.timerStartedAt = Date.now();
      if (room.currentIdx >= room.auctionQueue.length) room.phase = 'complete';
      return res.status(200).json(room);
    }

    if (body.action === 'start') {
      if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });
      const room = rooms[code];
      room.phase = 'auction';
      room.auctionQueue = [...room.roster].sort(() => Math.random() - 0.5);
      room.currentIdx = 0;
      room.currentBid = room.auctionQueue[0]?.base || 0;
      room.currentBidderId = null;
      room.isSold = false;
      room.bidLog = [];
      room.timerStartedAt = Date.now();
      room.participants.forEach((p) => {
        p.budget = room.settings.budget;
        p.squad = [];
      });
      return res.status(200).json(room);
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
