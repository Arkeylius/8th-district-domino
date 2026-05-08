import { Room, Client } from "colyseus";

type DominoTile = { id: string; left: number; right: number; };
type BranchSide = "left" | "right" | "top" | "bottom";

type Player = {
  id: string; name: string; hand: DominoTile[]; score: number;
  seatNumber: number; hideScore: boolean; avatarUrl: string;
};

type BoardTile = DominoTile & {
  playedBy: string;
  branchSide?: BranchSide;
  inward: number;
  outward: number;
};

type BoardBranches = { left: BoardTile[]; right: BoardTile[]; top: BoardTile[]; bottom: BoardTile[]; };

type LegalMoveResult = {
  legal: boolean; reason: string;
  inward?: number; outward?: number;
};

export class TableRoom extends Room {
  maxClients = 100;
  static usedNames = new Set<string>();

  tableId = this.createTableId();

  players: Player[] = []; spectators: Player[] = []; queue: Player[] = [];

  boardCenter: BoardTile | null = null;
  boardBranches: BoardBranches = { left: [], right: [], top: [], bottom: [] };
  boneyard: DominoTile[] = [];

  currentTurnIndex = 0; gameStarted = false; bonesWashed = false; roundNumber = 0;
  spinnerId: string | null = null; spinnerValue: number | null = null;
  lastAction = "Waiting for players.";

  currentHostId: string | null = null; pendingHostIndex: number = -1;

  turnTimer: any = null; nextRoundTimer: any = null;
  turnStartedAt = 0; turnExpiresAt = 0; hasDrawnThisTurn: boolean = false;

  forcedFirstTileId: string | null = null;
  previousRoundBlocked: boolean = false;
  lastRoundWinnerId: string | null = null;

  inviteCode = this.createInviteCode();

  tableOptions = {
    tableName: "", playerCount: 4, handSize: 7, gameMode: "allFives",
    drawRule: "drawUntilPlayable" as "drawUntilPlayable" | "drawAndPass",
    scoringMode: "standard", collectionMode: "allPlayers", passPenalty: true,
    turnTimerSeconds: 30, turnOrder: "clockwise", isPrivate: false, allowSpectators: true,
    targetScore: 150, forceRandomMoveOnTimeout: true,
    hostIntro: "Welcome to my table. Play fair, respect the table, and do not stall the game.",
    tableLaunched: false, autoRounds: true
  };

  onCreate() {
    this.tableOptions.tableName = "Table " + this.tableId;
    TableRoom.usedNames.add(this.tableOptions.tableName.toLowerCase());
    this.setMetadata(this.getLobbyData());

    this.onMessage("joinTable", (client, message) => this.handleJoin(client, message));
    this.onMessage("watchTable", (client, message) => this.handleWatch(client, message));
    this.onMessage("reserveSeat", (client, message) => this.handleReserveSeat(client, message));
    this.onMessage("leaveTable", (client) => this.handleLeave(client));
    this.onMessage("becomeSpectator", (client) => this.handleBecomeSpectator(client));
    this.onMessage("chat", (client, message) => this.handleChat(client, message));
    this.onMessage("launchGame", (client, message) => this.handleLaunchGame(client, message));
    this.onMessage("playTile", (client, message) => this.handlePlayTile(client, message));
    this.onMessage("knock", (client) => this.handleKnock(client));
    this.onMessage("drawBone", (client) => this.handleDrawBone(client));
    this.onMessage("setOptions", (client, message) => this.handleSetOptions(client, message));
    this.onMessage("setScoreVisibility", (client, message) => this.handleSetScoreVisibility(client, message));
    this.onMessage("respondToHostOffer", (client, message) => this.handleHostOfferResponse(client, message));
  }

  createTableId() { return "TBL-" + Math.random().toString(36).substring(2, 8).toUpperCase(); }
  createInviteCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

  getLobbyData() {
    const host = this.players.find(p => p.id === this.currentHostId);
    return {
      tableId: this.tableId, tableName: this.tableOptions.tableName, hostName: host ? host.name : "Inactive - No Host",
      scoringMode: this.tableOptions.scoringMode, drawRule: this.tableOptions.drawRule,
      playerSeats: this.players.length, maxPlayers: this.tableOptions.playerCount,
      spectators: this.spectators.length, queue: this.queue.length, gameStarted: this.gameStarted,
      roundNumber: this.roundNumber, isPrivate: this.tableOptions.isPrivate,
      allowSpectators: this.tableOptions.allowSpectators, tableLaunched: this.tableOptions.tableLaunched
    };
  }

  updateLobbyMetadata() { this.setMetadata(this.getLobbyData()); }

  createDeck(): DominoTile[] {
    const deck: DominoTile[] = [];
    for (let left = 0; left <= 6; left++) { for (let right = left; right <= 6; right++) { deck.push({ id: `${left}-${right}`, left, right }); } }
    return deck;
  }

  shuffle(deck: DominoTile[]) {
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
  }

  createPerson(client: Client, name: string, avatarUrl = ""): Player { return { id: client.sessionId, name, hand: [], score: 0, seatNumber: 0, hideScore: false, avatarUrl }; }
  roundToNearestFive(value: number) { return Math.round(value / 5) * 5; }

  handleNameChange(client: Client, newName: string | undefined): boolean {
    const requestedName = newName?.trim(); if (!requestedName) return true;
    const currentNameLower = this.tableOptions.tableName.toLowerCase(); const newNameLower = requestedName.toLowerCase();
    if (newNameLower === currentNameLower) return true;
    if (TableRoom.usedNames.has(newNameLower)) { this.send(client, "errorMessage", { text: "That Table Name is already in use by another district table." }); return false; }
    TableRoom.usedNames.delete(currentNameLower); this.tableOptions.tableName = requestedName; TableRoom.usedNames.add(newNameLower); return true;
  }

  applyTableOptions(message: any) {
    this.tableOptions = { ...this.tableOptions, ...message, gameMode: "allFives", turnOrder: "clockwise", forceRandomMoveOnTimeout: true };
    if (!["drawUntilPlayable", "drawAndPass"].includes(this.tableOptions.drawRule)) this.tableOptions.drawRule = "drawUntilPlayable";
    if (this.tableOptions.playerCount === 4) this.tableOptions.handSize = 7;
    else if (this.tableOptions.playerCount === 2) { if (this.tableOptions.handSize !== 7 && this.tableOptions.handSize !== 9) this.tableOptions.handSize = 7; }

    while (this.players.length > this.tableOptions.playerCount) {
      const removed = this.players.pop();
      if (removed) { removed.hand = []; removed.seatNumber = 0; this.spectators.push(removed); this.addToQueue(removed); }
    }
    this.assignClockwiseSeats();
  }

  handleJoin(client: Client, message: any) {
    const name = message?.name || "Guest"; const avatarUrl = message?.avatarUrl || "";
    if (this.isAlreadyAtTable(client.sessionId)) return;
    if (this.tableOptions.isPrivate && this.players.length > 0) {
      if (message?.inviteCode !== this.inviteCode) { this.send(client, "errorMessage", { text: "This is a private table. You need the invite code to join as a player." }); return; }
    }
    const playerObj = this.createPerson(client, name, avatarUrl);
    if (this.players.length < this.tableOptions.playerCount) {
      this.seatPlayer(playerObj); if (!this.currentHostId) this.currentHostId = client.sessionId;
      this.lastAction = `${name} joined as Seat ${playerObj.seatNumber}.`; this.tryAutoStartRound();
    } else {
      this.spectators.push(playerObj); this.addToQueue(playerObj); this.lastAction = `${name} is watching and reserved the next open seat.`;
    }
    this.broadcastPublicState(); this.sendPrivateHands();
  }

  handleWatch(client: Client, message: any) {
    const name = message?.name || "Guest"; const avatarUrl = message?.avatarUrl || "";
    if (this.isAlreadyAtTable(client.sessionId)) return;
    this.spectators.push(this.createPerson(client, name, avatarUrl)); this.lastAction = `${name} is watching the table.`; this.broadcastPublicState();
  }

  handleReserveSeat(client: Client, message: any) {
    const name = message?.name || "Guest"; const avatarUrl = message?.avatarUrl || "";
    let person = this.findPlayerOrSpectator(client.sessionId);
    if (this.players.some(player => player.id === client.sessionId)) { this.send(client, "errorMessage", { text: "You are already seated as a player." }); return; }
    if (!person) { person = this.createPerson(client, name, avatarUrl); this.spectators.push(person); }
    if (this.queue.some(player => player.id === client.sessionId)) { this.send(client, "errorMessage", { text: "You are already in the seat queue." }); return; }
    if (this.players.length < this.tableOptions.playerCount) {
      this.spectators = this.spectators.filter(player => player.id !== client.sessionId); this.seatPlayer(person);
      this.lastAction = `${person.name} reserved a seat and was seated immediately.`; this.tryAutoStartRound();
    } else {
      this.addToQueue(person); this.lastAction = `${person.name} reserved the next open seat.`;
    }
    this.broadcastPublicState(); this.sendPrivateHands();
  }

  addToQueue(player: Player) { if (!this.queue.some(queued => queued.id === player.id)) { player.seatNumber = 0; this.queue.push(player); } }
  seatPlayer(player: Player) { player.seatNumber = this.players.length + 1; this.players.push(player); this.assignClockwiseSeats(); }

  promoteNextQueuedSpectator() {
    if (this.players.length >= this.tableOptions.playerCount) return;
    const nextPlayer = this.queue.shift(); if (!nextPlayer) return;
    this.spectators = this.spectators.filter(player => player.id !== nextPlayer.id); nextPlayer.hand = []; this.seatPlayer(nextPlayer);
    this.lastAction = `${nextPlayer.name} was automatically seated from the reserve queue.`;
  }

  handleBecomeSpectator(client: Client) {
    const playerIndex = this.players.findIndex(p => p.id === client.sessionId); if (playerIndex === -1) return;
    const player = this.players[playerIndex]; const wasCurrentPlayer = this.currentTurnIndex === playerIndex; const isLeavingHost = this.currentHostId === client.sessionId;
    this.players.splice(playerIndex, 1); player.hand = []; player.seatNumber = 0; this.spectators.push(player);
    this.lastAction = `${player.name} left their seat to spectate the table.`;
    this.assignClockwiseSeats();
    if (!this.gameStarted) { this.promoteNextQueuedSpectator(); this.assignClockwiseSeats(); this.tryAutoStartRound(); }
    if (this.players.length === 0) { this.resetToEmptyTable(); } else {
      if (isLeavingHost) { this.currentHostId = null; this.offerHostToNext(0); }
      if (this.currentTurnIndex >= this.players.length || wasCurrentPlayer) { this.currentTurnIndex = this.currentTurnIndex % this.players.length; if (this.gameStarted) this.startTurnTimer(); }
    }
    this.broadcastPublicState(); this.sendPrivateHands();
  }

  handleLeave(client: Client) {
    const wasCurrentPlayer = this.players[this.currentTurnIndex]?.id === client.sessionId; const leavingPlayer = this.findPlayerOrSpectator(client.sessionId); const isLeavingHost = this.currentHostId === client.sessionId;
    this.players = this.players.filter(p => p.id !== client.sessionId); this.spectators = this.spectators.filter(p => p.id !== client.sessionId); this.queue = this.queue.filter(p => p.id !== client.sessionId);
    if (leavingPlayer) this.lastAction = `${leavingPlayer.name} left the table.`;
    this.assignClockwiseSeats();
    if (!this.gameStarted) { this.promoteNextQueuedSpectator(); this.assignClockwiseSeats(); this.tryAutoStartRound(); }
    if (this.players.length === 0) { this.resetToEmptyTable(); } else {
      if (isLeavingHost) { this.currentHostId = null; this.offerHostToNext(0); }
      if (this.currentTurnIndex >= this.players.length || wasCurrentPlayer) { this.currentTurnIndex = this.currentTurnIndex % this.players.length; if (this.gameStarted) this.startTurnTimer(); }
    }
    this.broadcastPublicState(); this.sendPrivateHands();
  }
  
  resetToEmptyTable() {
      this.clearTurnTimer(); this.clearNextRoundTimer();
      this.currentTurnIndex = 0; this.gameStarted = false; this.bonesWashed = false;
      this.currentHostId = null; this.pendingHostIndex = -1;
      this.resetBoard(); this.boneyard = []; this.spinnerId = null; this.spinnerValue = null;
      this.lastAction = "Waiting for players."; this.forcedFirstTileId = null; this.previousRoundBlocked = false; this.lastRoundWinnerId = null;
  }

  offerHostToNext(index: number) {
    if (index >= this.players.length) { this.lastAction = "Table is currently inactive. No one accepted host ownership."; this.broadcastPublicState(); return; }
    this.pendingHostIndex = index; const candidate = this.players[index]; const candidateClient = this.clients.find(c => c.sessionId === candidate.id);
    if (candidateClient) { this.send(candidateClient, "hostOffer", { text: "The host has left. Do you want to take ownership of this table?" }); }
  }

  handleHostOfferResponse(client: Client, message: any) {
    if (this.pendingHostIndex === -1) return; if (this.players[this.pendingHostIndex]?.id !== client.sessionId) return;
    if (message.accept) { this.currentHostId = client.sessionId; this.lastAction = `${this.players[this.pendingHostIndex].name} is now the host.`; this.pendingHostIndex = -1; } 
    else { this.offerHostToNext(this.pendingHostIndex + 1); }
    this.updateLobbyMetadata(); this.broadcastPublicState();
  }

  assignClockwiseSeats() { this.players.forEach((player, index) => { player.seatNumber = index + 1; }); }
  handleChat(client: Client, message: any) { const sender = this.findPlayerOrSpectator(client.sessionId); if (!sender) return; this.broadcast("chat", { name: sender.name, text: message.text }); }

  handleSetOptions(client: Client, message: any) {
    if (this.gameStarted) { this.send(client, "errorMessage", { text: "Cannot change options after game starts." }); return; }
    if (!this.isHost(client.sessionId)) { this.send(client, "errorMessage", { text: "Only the host can change table options." }); return; }
    if (!this.handleNameChange(client, message.tableName)) return;
    this.applyTableOptions(message); this.lastAction = "Host updated table options."; this.broadcastPublicState();
  }

  handleLaunchGame(client: Client, message: any) {
    if (!this.isHost(client.sessionId)) { this.send(client, "errorMessage", { text: "Only the host can launch the table." }); return; }
    if (this.gameStarted) return;
    if (!this.handleNameChange(client, message.tableName)) return;
    this.applyTableOptions(message); this.tableOptions.tableLaunched = true;
    if (this.players.length < this.tableOptions.playerCount) { this.lastAction = `Table launched. Waiting for ${this.tableOptions.playerCount - this.players.length} more player(s).`; this.broadcastPublicState(); return; }
    this.autoWashAndStartRound("Table launched. Bones are washing...");
  }

  tryAutoStartRound() {
    if (!this.tableOptions.tableLaunched || this.gameStarted || this.players.length < this.tableOptions.playerCount) return;
    this.autoWashAndStartRound("All seats filled. Bones are washing...");
  }

  autoWashAndStartRound(message: string) {
    this.clearNextRoundTimer(); this.clearTurnTimer();
    if (this.players.length < this.tableOptions.playerCount) { this.lastAction = `Waiting for ${this.tableOptions.playerCount - this.players.length} more player(s).`; this.broadcastPublicState(); return; }
    this.bonesWashed = true; this.lastAction = message;
    this.broadcast("bonesWashed", { text: message }); this.broadcastPublicState();
    setTimeout(() => { this.startNewRound(); }, 2000);
  }

  resetBoard() {
    this.boardCenter = null; this.boardBranches = { left: [], right: [], top: [], bottom: [] };
    this.spinnerId = null; this.spinnerValue = null;
  }

  findStartingPlayerAndTile() {
    let bestIndex = this.players.findIndex(p => p.hand.some(t => t.id === "6-6"));
    if (bestIndex !== -1) return { bestIndex, bestTileId: "6-6" };
    bestIndex = 0; let bestDouble = -1; let bestTileId = "";
    this.players.forEach((p, i) => { p.hand.forEach(t => { if (t.left === t.right && t.left > bestDouble) { bestDouble = t.left; bestIndex = i; bestTileId = t.id; } }); });
    if (bestDouble !== -1) return { bestIndex, bestTileId };
    let bestPipTotal = -1;
    this.players.forEach((p, i) => { p.hand.forEach(t => { const total = t.left + t.right; if (total > bestPipTotal) { bestPipTotal = total; bestIndex = i; bestTileId = t.id; } }); });
    return { bestIndex, bestTileId };
  }

  startNewRound() {
    this.hasDrawnThisTurn = false;
    const deck = this.shuffle(this.createDeck());
    this.players.forEach(player => { player.hand = deck.splice(0, this.tableOptions.handSize); });
    this.boneyard = deck; this.resetBoard();
    this.gameStarted = true; this.bonesWashed = true; this.roundNumber += 1;
    this.assignClockwiseSeats();

    if (this.roundNumber === 1 || this.previousRoundBlocked) {
        const { bestIndex, bestTileId } = this.findStartingPlayerAndTile();
        this.currentTurnIndex = bestIndex; this.forcedFirstTileId = bestTileId; this.previousRoundBlocked = false;
    } else {
        this.currentTurnIndex = this.players.findIndex(p => p.id === this.lastRoundWinnerId);
        if (this.currentTurnIndex === -1) this.currentTurnIndex = 0;
        this.forcedFirstTileId = null;
    }

    const starter = this.players[this.currentTurnIndex];
    this.lastAction = `${starter?.name || "A player"} starts round ${this.roundNumber}.`;
    this.startTurnTimer(); this.broadcastPublicState(); this.sendPrivateHands();
  }

  handleSetScoreVisibility(client: Client, message: any) {
    const player = this.players.find(p => p.id === client.sessionId);
    if (!player) return; player.hideScore = Boolean(message?.hideScore); this.broadcastPublicState();
  }

  startTurnTimer() {
    this.clearTurnTimer();
    if (!this.gameStarted || this.players.length < this.tableOptions.playerCount) return;
    this.turnStartedAt = Date.now(); this.turnExpiresAt = Date.now() + this.tableOptions.turnTimerSeconds * 1000;
    this.turnTimer = setTimeout(() => { this.handleTurnTimeout(); }, this.tableOptions.turnTimerSeconds * 1000);
    this.broadcastPublicState();
  }

  clearTurnTimer() { if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; } }
  clearNextRoundTimer() { if (this.nextRoundTimer) { clearTimeout(this.nextRoundTimer); this.nextRoundTimer = null; } }

  handleTurnTimeout() {
    if (!this.gameStarted) return;
    const player = this.players[this.currentTurnIndex]; if (!player) return;

    let legalMoves = this.getAllLegalMoves(player);
    if (legalMoves.length > 0) { const randomMove = legalMoves[Math.floor(Math.random() * legalMoves.length)]; this.forcePlayTile(player, randomMove.tile, randomMove.side); return; }

    if (this.boneyard.length > 0) {
      if (this.tableOptions.drawRule === "drawUntilPlayable") {
        while (this.boneyard.length > 0) { const drawn = this.boneyard.shift(); if (drawn) player.hand.push(drawn); if (this.getAllLegalMoves(player).length > 0) break; }
        this.lastAction = `${player.name} ran out of time! Randomly drew until playable.`;
      } else if (this.tableOptions.drawRule === "drawAndPass") {
        if (!this.hasDrawnThisTurn) { const drawn = this.boneyard.shift(); if (drawn) player.hand.push(drawn); this.lastAction = `${player.name} ran out of time! Drew one bone automatically.`; }
      }
      legalMoves = this.getAllLegalMoves(player);
      if (legalMoves.length > 0) { const randomMove = legalMoves[Math.floor(Math.random() * legalMoves.length)]; this.forcePlayTile(player, randomMove.tile, randomMove.side); return; }
    }

    this.lastAction = `${player.name} ran out of time and knocked.`;
    this.advanceTurnClockwise();
    if (this.isBlockedGame()) { this.endBlockedRound(); return; }
    this.startTurnTimer(); this.broadcastPublicState(); this.sendPrivateHands();
  }

  getAllLegalMoves(player: Player) {
    const moves: { tile: DominoTile; side: BranchSide }[] = [];
    player.hand.forEach(tile => { (["left", "right", "top", "bottom"] as BranchSide[]).forEach(side => { if (this.getLegalMove(tile, side).legal) moves.push({ tile, side }); }); });
    return moves;
  }

  getBranchOpenEnd(side: BranchSide): number | null {
    if (!this.boardCenter) return null;

    const centerIsDouble = this.boardCenter.left === this.boardCenter.right;

    if (side === "top" || side === "bottom") {
      if (!centerIsDouble) return null;
      if (this.boardBranches.left.length === 0 || this.boardBranches.right.length === 0) return null;
    }

    const branch = this.boardBranches[side];
    if (branch.length > 0) return branch[branch.length - 1].outward;

    if (side === "left") return this.boardCenter.inward; 
    if (side === "right") return this.boardCenter.outward; 
    if (side === "top" || side === "bottom") return this.boardCenter.left; 

    return null; 
  }

  // FIXED SCORING ENGINE: Properly calculates exposed doubles.
  getOpenEndTotal() {
    if (!this.boardCenter) return 0;
    let total = 0;

    const getBranchVal = (branch: BoardTile[]) => {
      if (branch.length === 0) return 0;
      const last = branch[branch.length - 1];
      if (last.left === last.right) return last.left + last.right; // Double on the end counts fully
      return last.outward; // Single on the end counts outward
    };

    const leftEmpty = this.boardBranches.left.length === 0;
    const rightEmpty = this.boardBranches.right.length === 0;
    const topEmpty = this.boardBranches.top.length === 0;
    const bottomEmpty = this.boardBranches.bottom.length === 0;
    const centerIsDouble = this.boardCenter.left === this.boardCenter.right;

    // If it's the very first tile, evaluate both sides.
    if (leftEmpty && rightEmpty && topEmpty && bottomEmpty) {
      return this.boardCenter.left + this.boardCenter.right;
    }

    // Evaluate Left Branch
    if (leftEmpty) {
      // If the left side is empty, the center tile is the "end". 
      // If the center tile is a double, the entire double counts (left + right).
      total += centerIsDouble ? (this.boardCenter.left + this.boardCenter.right) : this.boardCenter.inward;
    } else {
      total += getBranchVal(this.boardBranches.left);
    }

    // Evaluate Right Branch
    if (rightEmpty) {
      // Avoid double-counting the starting double if both left and right are somehow empty.
      // (The block above already returned if everything was empty, so we are safe here).
      total += centerIsDouble ? (this.boardCenter.left + this.boardCenter.right) : this.boardCenter.outward;
    } else {
      total += getBranchVal(this.boardBranches.right);
    }

    // Evaluate Top & Bottom Branches (they only count if tiles are played on them)
    if (!topEmpty) total += getBranchVal(this.boardBranches.top);
    if (!bottomEmpty) total += getBranchVal(this.boardBranches.bottom);

    return total;
  }

  getProjectedOpenEndTotal(tile: DominoTile, side: BranchSide, legalMove: LegalMoveResult) {
    const boardTile: BoardTile = { ...tile, playedBy: "temp", branchSide: side, inward: legalMove.inward!, outward: legalMove.outward! };
    let addedToCenter = false;
    if (!this.boardCenter) { this.boardCenter = boardTile; addedToCenter = true; } 
    else { this.boardBranches[side].push(boardTile); }
    const total = this.getOpenEndTotal();
    if (addedToCenter) { this.boardCenter = null; } else { this.boardBranches[side].pop(); }
    return total;
  }

  canSlamMove(player: Player, tile: DominoTile, side: BranchSide) {
    const legalMove = this.getLegalMove(tile, side);
    if (!legalMove.legal) return false;
    const projectedOpenTotal = this.getProjectedOpenEndTotal(tile, side, legalMove);
    const projectedScore = this.calculateScore(projectedOpenTotal);
    if (projectedScore >= 20) return true;
    if (projectedScore > 0 && player.score + projectedScore >= this.tableOptions.targetScore) return true;
    return false;
  }

  forcePlayTile(player: Player, tile: DominoTile, side: BranchSide) {
    const tileIndex = player.hand.findIndex(t => t.id === tile.id); if (tileIndex === -1) return;
    const legalMove = this.getLegalMove(tile, side); if (!legalMove.legal) return;
    player.hand.splice(tileIndex, 1);
    if (this.forcedFirstTileId === tile.id) this.forcedFirstTileId = null;

    this.placeTileOnBoard(player, tile, side, legalMove);
    const openTotal = this.getOpenEndTotal();
    const scored = this.calculateScore(openTotal);

    if (scored > 0) player.score += scored;
    this.lastAction = `${player.name} ran out of time! Randomly forced to play ${tile.left}|${tile.right}.`;
    this.broadcast("movePlayed", { playerName: player.name, seatNumber: player.seatNumber, tile: `${tile.left}|${tile.right}`, side, openTotal, scored, slam: false, forced: true });
    if (player.hand.length === 0) { this.endRoundDomino(player); return; }
    this.advanceTurnClockwise();
    if (this.isBlockedGame()) { this.endBlockedRound(); return; }
    this.startTurnTimer(); this.broadcastPublicState(); this.sendPrivateHands();
  }

  handlePlayTile(client: Client, message: any) {
    if (!this.gameStarted) return;
    const player = this.players[this.currentTurnIndex];
    if (!player || player.id !== client.sessionId) { this.send(client, "errorMessage", { text: "It is not your turn." }); return; }

    const tileId = message?.tileId; const side = (message?.side || "right") as BranchSide; let slam = Boolean(message?.slam);
    const tileIndex = player.hand.findIndex(tile => tile.id === tileId); if (tileIndex === -1) return;
    const tile = player.hand[tileIndex];
    const legalMove = this.getLegalMove(tile, side);

    if (!legalMove.legal) { this.send(client, "errorMessage", { text: legalMove.reason }); return; }
    if (!this.canSlamMove(player, tile, side)) slam = false;

    this.clearTurnTimer(); player.hand.splice(tileIndex, 1);
    if (this.forcedFirstTileId === tile.id) this.forcedFirstTileId = null;

    this.placeTileOnBoard(player, tile, side, legalMove);

    const openTotal = this.getOpenEndTotal();
    const scored = this.calculateScore(openTotal);

    if (scored > 0) player.score += scored;

    this.lastAction = `${player.name} ${slam ? "slammed" : "played"} ${tile.left}|${tile.right}.`;
    this.broadcast("movePlayed", { playerName: player.name, seatNumber: player.seatNumber, tile: `${tile.left}|${tile.right}`, side, openTotal, scored, slam, forced: false });

    if (slam) {
      this.broadcast("slam", {
        playerId: player.id, playerName: player.name, seatNumber: player.seatNumber,
        tile: `${tile.left}|${tile.right}`, side, tableRock: true, scatterTiles: true, durationMs: 1500, restoreTilesAfterMs: 1200, intensity: "heavy"
      });
    }

    if (player.hand.length === 0) { this.endRoundDomino(player); return; }
    this.advanceTurnClockwise();
    if (this.isBlockedGame()) { this.endBlockedRound(); return; }
    this.startTurnTimer(); this.broadcastPublicState(); this.sendPrivateHands();
  }

  placeTileOnBoard(player: Player, tile: DominoTile, side: BranchSide, legalMove: LegalMoveResult) {
    const boardTile: BoardTile = { ...tile, playedBy: player.id, branchSide: side, inward: legalMove.inward!, outward: legalMove.outward! };

    if (!this.boardCenter) {
      this.boardCenter = boardTile;
      if (tile.left === tile.right) { this.spinnerId = tile.id; this.spinnerValue = tile.left; }
      return;
    }

    if (!this.spinnerId && tile.left === tile.right) { this.spinnerId = tile.id; this.spinnerValue = tile.left; }
    this.boardBranches[side].push(boardTile);
  }

  handleDrawBone(client: Client) {
    if (!this.gameStarted) return;
    const player = this.players[this.currentTurnIndex]; if (!player || player.id !== client.sessionId) return;
    if (this.playerHasLegalMove(player)) { this.send(client, "errorMessage", { text: "You have a legal move. You cannot draw." }); return; }
    if (this.tableOptions.drawRule === "drawAndPass" && this.hasDrawnThisTurn) { this.send(client, "errorMessage", { text: "You can only draw one bone per turn." }); return; }
    if (this.boneyard.length === 0) { this.send(client, "errorMessage", { text: "Boneyard is empty. Knock to pass." }); return; }

    const drawn = this.boneyard.shift();
    if (drawn) { player.hand.push(drawn); this.hasDrawnThisTurn = true; this.lastAction = `${player.name} drew from the boneyard.`; }
    this.broadcastPublicState(); this.sendPrivateHands();
  }

  handleKnock(client: Client) {
    if (!this.gameStarted) return;
    const player = this.players[this.currentTurnIndex]; if (!player || player.id !== client.sessionId) return;
    if (this.playerHasLegalMove(player)) { this.send(client, "errorMessage", { text: "You have a legal move, so you cannot knock." }); return; }
    if (this.boneyard.length > 0) {
      if (this.tableOptions.drawRule === "drawUntilPlayable") { this.send(client, "errorMessage", { text: "You must draw until you can play." }); return; }
      if (this.tableOptions.drawRule === "drawAndPass" && !this.hasDrawnThisTurn) { this.send(client, "errorMessage", { text: "You must draw a bone before passing." }); return; }
    }

    this.clearTurnTimer();
    const previousPlayer = this.getPreviousClockwisePlayer();
    if (this.tableOptions.passPenalty && previousPlayer && previousPlayer.id !== player.id) { previousPlayer.score += 10; }

    this.lastAction = `${player.name} knocked.`;
    this.broadcast("knock", { playerName: player.name });
    this.advanceTurnClockwise();
    if (this.isBlockedGame()) { this.endBlockedRound(); return; }
    this.startTurnTimer(); this.broadcastPublicState(); this.sendPrivateHands();
  }

  getLegalMove(tile: DominoTile, side: BranchSide): LegalMoveResult {
    if (!this.boardCenter) {
      if (this.forcedFirstTileId && tile.id !== this.forcedFirstTileId) {
        return { legal: false, reason: "You must start the round with your highest double (or highest pip)!" };
      }
      return { legal: true, reason: "", inward: tile.left, outward: tile.right };
    }

    const centerIsDouble = this.boardCenter.left === this.boardCenter.right;
    if (side === "top" || side === "bottom") {
        if (!centerIsDouble) return { legal: false, reason: "You can only play top/bottom off a double spinner." };
        if (this.boardBranches.left.length === 0 || this.boardBranches.right.length === 0) {
            return { legal: false, reason: "Both left and right sides of the spinner must be played first." };
        }
    }

    const openEnd = this.getBranchOpenEnd(side);
    if (openEnd === null) return { legal: false, reason: "That branch is not open yet." };

    if (tile.left === openEnd) return { legal: true, reason: "", inward: tile.left, outward: tile.right };
    if (tile.right === openEnd) return { legal: true, reason: "", inward: tile.right, outward: tile.left };

    return { legal: false, reason: `Tile ${tile.left}|${tile.right} does not match the open end (${openEnd}).` };
  }

  getOpenEnds() {
    if (!this.boardCenter) return { left: null, right: null, top: null, bottom: null };
    return {
      left: this.getBranchOpenEnd("left"), right: this.getBranchOpenEnd("right"),
      top: this.getBranchOpenEnd("top"), bottom: this.getBranchOpenEnd("bottom")
    };
  }

  getFlatBoard() {
    const tiles: BoardTile[] = [];
    if (this.boardCenter) tiles.push(this.boardCenter);
    return tiles.concat(this.boardBranches.left, this.boardBranches.right, this.boardBranches.top, this.boardBranches.bottom);
  }

  calculateScore(openEndTotal: number) {
    if (this.tableOptions.scoringMode === "noFive" && openEndTotal === 5) return 0;
    if (openEndTotal > 0 && openEndTotal % 5 === 0) return openEndTotal;
    return 0;
  }

  playerHasLegalMove(player: Player) { return this.getAllLegalMoves(player).length > 0; }

  isBlockedGame() {
    if (!this.gameStarted) return false;
    if (this.boneyard.length > 0) return false;
    return this.players.length > 0 && this.players.every(player => !this.playerHasLegalMove(player));
  }

  advanceTurnClockwise() {
    this.hasDrawnThisTurn = false;
    if (this.players.length === 0) { this.currentTurnIndex = 0; return; }
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
  }

  getPreviousClockwisePlayer() {
    if (this.players.length === 0) return null;
    const previousIndex = (this.currentTurnIndex - 1 + this.players.length) % this.players.length;
    return this.players[previousIndex];
  }

  getPartnerSeat(seatNumber: number) {
    if (this.tableOptions.playerCount !== 4) return null;
    if (seatNumber === 1) return 3; if (seatNumber === 3) return 1;
    if (seatNumber === 2) return 4; if (seatNumber === 4) return 2;
    return null;
  }

  getPreviousClockwisePlayerFor(player: Player) {
    const index = this.players.findIndex(p => p.id === player.id);
    if (index === -1 || this.players.length === 0) return null;
    const previousIndex = (index - 1 + this.players.length) % this.players.length;
    return this.players[previousIndex];
  }

  shouldCollectFrom(winner: Player, other: Player) {
    if (winner.id === other.id) return false;
    if (this.tableOptions.collectionMode === "backMan") {
      const previousPlayer = this.getPreviousClockwisePlayerFor(winner);
      return previousPlayer?.id === other.id;
    }
    if (this.tableOptions.collectionMode === "partners") {
      const partnerSeat = this.getPartnerSeat(winner.seatNumber);
      return other.seatNumber !== partnerSeat;
    }
    return true;
  }

  calculateRoundedRoundCollection(winner: Player) {
    let rawPoints = 0;
    this.players.forEach(player => { if (this.shouldCollectFrom(winner, player)) { rawPoints += this.sumHand(player.hand); } });
    return this.roundToNearestFive(rawPoints);
  }

  endRoundDomino(winner: Player) {
    this.clearTurnTimer(); this.previousRoundBlocked = false; this.lastRoundWinnerId = winner.id;
    const collectedPoints = this.calculateRoundedRoundCollection(winner);
    winner.score += collectedPoints;
    this.finishRound(`${winner.name} dominoed and collected ${collectedPoints} points.`);
  }

  endBlockedRound() {
    this.clearTurnTimer(); this.previousRoundBlocked = true; this.lastRoundWinnerId = null;
    const winner = this.findLowestHandPlayer(); if (!winner) return;
    const collectedPoints = this.calculateRoundedRoundCollection(winner);
    winner.score += collectedPoints;
    this.finishRound(`Board locked. ${winner.name} had the lowest hand and won ${collectedPoints} points.`);
  }

  finishRound(message: string) {
    this.clearTurnTimer(); this.gameStarted = false; this.bonesWashed = false; this.lastAction = message;
    const gameWinner = this.players.find(player => player.score >= this.tableOptions.targetScore);
    if (gameWinner) {
      this.lastAction = `${gameWinner.name} won the game with ${gameWinner.score} points.`;
      this.broadcastPublicState(); this.sendPrivateHands(); return;
    }
    this.broadcastPublicState(); this.sendPrivateHands();
    if (this.tableOptions.autoRounds) {
      this.nextRoundTimer = setTimeout(() => { this.autoWashAndStartRound("New round started. Bones are washing..."); }, 4000);
    }
  }

  findLowestHandPlayer() {
    if (this.players.length === 0) return null;
    let winner = this.players[0]; let lowest = this.sumHand(winner.hand);
    this.players.forEach(player => { const total = this.sumHand(player.hand); if (total < lowest) { lowest = total; winner = player; } });
    return winner;
  }

  sumHand(hand: DominoTile[]) { return hand.reduce((total, tile) => total + tile.left + tile.right, 0); }
  getCurrentTurnPlayer() { if (this.players.length === 0) return null; return this.players[this.currentTurnIndex] || null; }
  isHost(sessionId: string) { return this.currentHostId === sessionId; }
  isAlreadyAtTable(id: string) { return this.players.some(p => p.id === id) || this.spectators.some(p => p.id === id); }
  findPlayerOrSpectator(id: string) { return this.players.find(p => p.id === id) || this.spectators.find(p => p.id === id); }

  getPublicState(viewerId?: string) {
    const currentTurn = this.getCurrentTurnPlayer(); const now = Date.now();
    return {
      tableId: this.tableId,
      players: this.players.map(player => {
        const isSelf = viewerId === player.id; const scoreHiddenForViewer = player.hideScore && !isSelf;
        return {
          id: player.id, name: player.name, score: scoreHiddenForViewer ? null : player.score,
          scoreHidden: player.hideScore, handCount: player.hand.length, seatNumber: player.seatNumber,
          isHost: this.isHost(player.id), avatarUrl: player.avatarUrl
        };
      }),
      spectators: this.spectators.map(player => ({ id: player.id, name: player.name, avatarUrl: player.avatarUrl })),
      queue: this.queue.map((player, index) => ({ id: player.id, name: player.name, queuePosition: index + 1, avatarUrl: player.avatarUrl })),
      board: this.getFlatBoard(), boardCenter: this.boardCenter, boardBranches: this.boardBranches, boneyardCount: this.boneyard.length,
      currentTurn: currentTurn ? { id: currentTurn.id, name: currentTurn.name, seatNumber: currentTurn.seatNumber } : null,
      gameStarted: this.gameStarted, bonesWashed: this.bonesWashed, spinnerId: this.spinnerId, spinnerValue: this.spinnerValue,
      roundNumber: this.roundNumber, lastAction: this.lastAction, tableOptions: this.tableOptions,
      openEnds: this.getOpenEnds(), openEndTotal: this.getOpenEndTotal(), turnStartedAt: this.turnStartedAt, turnExpiresAt: this.turnExpiresAt,
      turnSecondsLeft: this.gameStarted ? Math.max(0, Math.ceil((this.turnExpiresAt - now) / 1000)) : 0,
      hostId: this.currentHostId || null, hostName: this.players.find(p => p.id === this.currentHostId)?.name || null,
      inviteCode: this.players.length > 0 ? this.inviteCode : null, hasDrawnThisTurn: this.hasDrawnThisTurn
    };
  }

  broadcastPublicState() { this.updateLobbyMetadata(); this.clients.forEach(client => { this.send(client, "update", this.getPublicState(client.sessionId)); }); }
  sendPrivateHands() { this.players.forEach(player => { const client = this.clients.find(c => c.sessionId === player.id); if (client) this.send(client, "yourHand", { hand: player.hand }); }); }
  onJoin(client: Client) { console.log(client.sessionId, "connected"); this.send(client, "update", this.getPublicState(client.sessionId)); this.updateLobbyMetadata(); }
  onLeave(client: Client) { this.handleLeave(client); }
  onDispose() { TableRoom.usedNames.delete(this.tableOptions.tableName.toLowerCase()); this.clearTurnTimer(); this.clearNextRoundTimer(); }
}