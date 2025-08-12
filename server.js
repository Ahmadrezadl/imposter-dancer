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
            scores: {},
            danceTime: 30000, // 30s
            voteTime: 20000 // 20s
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

        // --- RECONNECTION LOGIC ---
        const reconnectingPlayer = rooms[roomCode].players.find(
            p => p.username === username && p.disconnected
        );

        if (reconnectingPlayer) {
            console.log(`${username} is reconnecting.`);
            clearTimeout(reconnectingPlayer.disconnectTimeout); // Cancel the removal timeout
            reconnectingPlayer.id = socket.id; // Assign the new socket ID
            reconnectingPlayer.disconnected = false;
        } else {
            // --- NEW PLAYER LOGIC (as before) ---
            rooms[roomCode].players.push({ id: socket.id, username, score: 0 });
        }
        // --- END OF NEW LOGIC ---

        socket.join(roomCode);
        socket.room = roomCode;
        socket.username = username;
        socket.emit('roomJoined', { roomCode, isHost: socket.id === rooms[roomCode].hostId });
        updatePlayerList(roomCode);
        io.to(roomCode).emit('playerJoined', username);
    });

    socket.on('startGame', () => {
        const room = socket.room;
        if (!room || socket.id !== rooms[room].hostId || rooms[room].gameInProgress || rooms[room].players.length < 2) {
            return;
        }
        rooms[room].gameInProgress = true;
        rooms[room].imposterIndex = Math.floor(Math.random() * rooms[room].players.length);
        rooms[room].imposterId = rooms[room].players[rooms[room].imposterIndex].id;
        rooms[room].votes = {};

        // Choose songs
        const normalSongIndex = Math.floor(Math.random() * normalSongs.length);
        const imposterSongIndex = Math.floor(Math.random() * imposterSongs.length);
        rooms[room].normalSong = normalSongs[normalSongIndex];
        rooms[room].imposterSong = imposterSongs[imposterSongIndex];

        const startTime = Date.now() + 5000;
        rooms[room].startTime = startTime;

        // Send to each player their song and imposter status
        rooms[room].players.forEach((player) => {
            const isImposter = player.id === rooms[room].imposterId;
            io.to(player.id).emit('gameStart', {
                songUrl: isImposter ? rooms[room].imposterSong : rooms[room].normalSong,
                startTime,
                players: rooms[room].players.map(p => ({ id: p.id, username: p.username, score: p.score })),
                isImposter,
                startOffset: 10
            });
        });

        // End dancing phase after danceTime
        setTimeout(() => startVotePhase(room), rooms[room].danceTime);
    });

    socket.on('danceMove', () => {
        const room = socket.room;
        if (room && rooms[room].gameInProgress) {
            io.to(room).emit('playerDance', socket.id);
        }
    });

    socket.on('vote', (votedId) => {
        const room = socket.room;
        if (room && rooms[room].gameInProgress && !rooms[room].votes[socket.id] && socket.id !== votedId) {
            rooms[room].votes[socket.id] = votedId;
        }
    });

    socket.on('updateSettings', ({ danceTime, voteTime }) => {
        const roomCode = socket.room;
        if (!roomCode || !rooms[roomCode] || socket.id !== rooms[roomCode].hostId) return;

        // Update server-side values (convert to milliseconds for setTimeout)
        rooms[roomCode].danceTime = parseInt(danceTime, 10) * 1000;
        rooms[roomCode].voteTime = parseInt(voteTime, 10) * 1000;

        console.log(`Room ${roomCode} settings updated by host.`);
    });

    socket.on('kickPlayer', (playerIdToKick) => {
        const roomCode = socket.room;
        if (!roomCode || !rooms[roomCode] || socket.id !== rooms[roomCode].hostId) return;

        // Find the socket of the player to be kicked
        const kickedSocket = io.sockets.sockets.get(playerIdToKick);
        if (kickedSocket) {
            kickedSocket.emit('kicked');
            kickedSocket.leave(roomCode);
        }

        // Remove player from the room's player list
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
            // This code runs if the player does NOT reconnect in time (e.g., 60 seconds)
            console.log(`${player.username} timed out and was removed.`);
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);

            // If the room is now empty, delete it
            if (rooms[roomCode].players.length === 0) {
                console.log(`Room ${roomCode} is empty, deleting.`);
                delete rooms[roomCode];
                return;
            }

            // If the disconnected player was the host, assign a new one
            if (player.id === rooms[roomCode].hostId) {
                rooms[roomCode].hostId = rooms[roomCode].players[0].id;
                console.log(`Host migrated to ${rooms[roomCode].players[0].username} in room ${roomCode}.`);
            }

            updatePlayerList(roomCode);

        }, 60000); // 60-second timeout

        updatePlayerList(roomCode); // Update list to show player as disconnected
    });
});

function updatePlayerList(room) {
    io.to(room).emit('playerList', {
        players: rooms[room].players,
        hostId: rooms[room].hostId,
        gameInProgress: rooms[room].gameInProgress
    });
}

function startVotePhase(room) {
    rooms[room].players.forEach((player) => {
        io.to(player.id).emit('votePhase', {
            players: rooms[room].players.filter(p => p.id !== player.id).map(p => ({ id: p.id, username: p.username, score: p.score }))
        });
    });
    setTimeout(() => endGame(room), rooms[room].voteTime);
}

function endGame(room) {
    const imposterId = rooms[room].imposterId;
    Object.keys(rooms[room].votes).forEach((voterId) => {
        if (voterId === imposterId) return; // Imposter's vote doesn't count for scoring
        const votedId = rooms[room].votes[voterId];
        const voter = rooms[room].players.find(p => p.id === voterId);
        const imposter = rooms[room].players.find(p => p.id === imposterId);
        if (votedId === imposterId) {
            voter.score += 1;
        } else {
            imposter.score += 1;
        }
    });

    io.to(room).emit('reveal', {
        imposterId,
        scores: rooms[room].players.map(p => ({ username: p.username, score: p.score }))
    });
    rooms[room].gameInProgress = false;
    updatePlayerList(room);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));