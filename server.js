const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 2323;

app.use(express.static('public'));

const rooms = {};
const normalSongs = [
    '/music/happy1.mp3',
    '/music/happy2.mp3',
    '/music/happy3.mp3'
];
const imposterSongs = [
    '/music/sad1.mp3',
    '/music/sad2.mp3',
    '/music/sad3.mp3'
];

function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    socket.on('createRoom', (username) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: [{ id: socket.id, username, score: 0 }],
            hostId: socket.id,
            gameInProgress: false,
            danceTime: 30000, // Default 30s
            voteTime: 20000 // Default 20s
        };
        socket.join(roomCode);
        socket.room = roomCode;
        socket.username = username;
        socket.emit('roomCreated', { roomCode, isHost: true });
        updatePlayerList(roomCode);
    });

    socket.on('joinRoom', ({ roomCode, username }) => {
        if (!rooms[roomCode]) {
            socket.emit('error', 'Room not found');
            return;
        }

        const reconnectingPlayer = rooms[roomCode].players.find(
            p => p.username === username && p.disconnected
        );

        if (reconnectingPlayer) {
            console.log(`${username} is reconnecting.`);
            clearTimeout(reconnectingPlayer.disconnectTimeout);
            reconnectingPlayer.id = socket.id;
            reconnectingPlayer.disconnected = false;
        } else {
            rooms[roomCode].players.push({ id: socket.id, username, score: 0 });
        }

        socket.join(roomCode);
        socket.room = roomCode;
        socket.username = username;
        socket.emit('roomJoined', { roomCode, isHost: socket.id === rooms[roomCode].hostId });
        updatePlayerList(roomCode);
        io.to(roomCode).emit('playerJoined', username);
    });

    socket.on('startGame', () => {
        const roomCode = socket.room;
        const room = rooms[roomCode];
        if (!room || socket.id !== room.hostId || room.gameInProgress || room.players.length < 2) {
            return;
        }
        room.gameInProgress = true;
        room.imposterIndex = Math.floor(Math.random() * room.players.length);
        room.imposterId = room.players[room.imposterIndex].id;
        room.votes = {};

        const normalSongIndex = Math.floor(Math.random() * normalSongs.length);
        const imposterSongIndex = Math.floor(Math.random() * imposterSongs.length);
        room.normalSong = normalSongs[normalSongIndex];
        room.imposterSong = imposterSongs[imposterSongIndex];

        const startTime = Date.now() + 5000; // 5s delay for countdown
        room.startTime = startTime;

        room.players.forEach((player) => {
            const isImposter = player.id === room.imposterId;
            io.to(player.id).emit('gameStart', {
                songUrl: isImposter ? room.imposterSong : room.normalSong,
                startTime,
                players: room.players.map(p => ({ id: p.id, username: p.username, score: p.score })),
                isImposter,
                startOffset: 10 // Start song at 10 seconds
            });
        });

        setTimeout(() => startVotePhase(roomCode), room.danceTime + 5000); // Add countdown time to dance phase
    });

    socket.on('danceMove', () => {
        const roomCode = socket.room;
        if (roomCode && rooms[roomCode] && rooms[roomCode].gameInProgress) {
            io.to(roomCode).emit('playerDance', socket.id);
        }
    });

    socket.on('vote', (votedId) => {
        const roomCode = socket.room;
        if (roomCode && rooms[roomCode] && rooms[roomCode].gameInProgress && !rooms[roomCode].votes[socket.id] && socket.id !== votedId) {
            rooms[roomCode].votes[socket.id] = votedId;
        }
    });

    socket.on('updateSettings', ({ danceTime, voteTime }) => {
        const roomCode = socket.room;
        if (!roomCode || !rooms[roomCode] || socket.id !== rooms[roomCode].hostId) return;
        rooms[roomCode].danceTime = parseInt(danceTime, 10) * 1000;
        rooms[roomCode].voteTime = parseInt(voteTime, 10) * 1000;
        console.log(`Room ${roomCode} settings updated by host.`);
    });

    socket.on('kickPlayer', (playerIdToKick) => {
        const roomCode = socket.room;
        if (!roomCode || !rooms[roomCode] || socket.id !== rooms[roomCode].hostId) return;

        const kickedSocket = io.sockets.sockets.get(playerIdToKick);
        if (kickedSocket) {
            kickedSocket.emit('kicked');
            kickedSocket.leave(roomCode);
        }
        rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== playerIdToKick);
        console.log(`Player ${playerIdToKick} kicked from room ${roomCode}.`);
        updatePlayerList(roomCode);
    });

    socket.on('disconnect', () => {
        const roomCode = socket.room;
        if (!roomCode || !rooms[roomCode]) return;

        const player = rooms[roomCode].players.find(p => p.id === socket.id);
        if (!player) return;

        console.log(`${player.username} disconnected.`);
        player.disconnected = true;

        player.disconnectTimeout = setTimeout(() => {
            console.log(`${player.username} timed out and was removed from ${roomCode}.`);
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== player.id);

            if (rooms[roomCode].players.length === 0) {
                console.log(`Room ${roomCode} is empty, deleting.`);
                delete rooms[roomCode];
                return;
            }

            if (player.id === rooms[roomCode].hostId) {
                rooms[roomCode].hostId = rooms[roomCode].players[0].id;
                console.log(`Host migrated to ${rooms[roomCode].players[0].username} in room ${roomCode}.`);
            }
            updatePlayerList(roomCode);
        }, 60000); // 60-second timeout

        updatePlayerList(roomCode);
    });
});

function updatePlayerList(roomCode) {
    if (!rooms[roomCode]) return;
    io.to(roomCode).emit('playerList', {
        players: rooms[roomCode].players,
        hostId: rooms[roomCode].hostId,
        gameInProgress: rooms[roomCode].gameInProgress
    });
}

function startVotePhase(roomCode) {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.players.forEach((player) => {
        io.to(player.id).emit('votePhase', {
            players: room.players.filter(p => p.id !== player.id).map(p => ({ id: p.id, username: p.username, score: p.score }))
        });
    });
    setTimeout(() => endGame(roomCode), room.voteTime);
}

function endGame(roomCode) {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    const imposterId = room.imposterId;
    const imposter = room.players.find(p => p.id === imposterId);

    Object.keys(room.votes).forEach((voterId) => {
        if (voterId === imposterId) return;
        const votedId = room.votes[voterId];
        const voter = room.players.find(p => p.id === voterId);
        if (votedId === imposterId) {
            voter.score++;
        } else {
            imposter.score++;
        }
    });

    io.to(roomCode).emit('reveal', {
        imposterId,
        scores: room.players.map(p => ({ username: p.username, score: p.score }))
    });
    room.gameInProgress = false;
    updatePlayerList(roomCode);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));