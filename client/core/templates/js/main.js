const answeredColor = '#606060';
let socket = null;
let disconnectCountdownIntervalId = null;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_STABLE_MS = 10000;
let reconnectExhausted = false;
let reconnectStableTimerId = null;

// QR code join: track the game ID from the ?game= query parameter
let qrJoinGameId = null;
// Both automatic join paths (socket open, and ClientStateChanged with a clear session) fire
// for the same QR link. The second Join finds the player already moved out of free_players
// and answers "Player not found", which this client treats as a terminal session loss —
// killing the session the first Join had just established. Join automatically once.
let autoJoinSent = false;
let qrJoinAwaitingPassword = false;

// Bot isolation: ?bot=1 routes state/role/name through sessionStorage (per-window).
window.pqBot = (function () {
    try { return new URL(window.location.href).searchParams.get('bot') === '1'; } catch (e) { return false; }
})();

window.pqStore = {
    getItem: (key) => (window.pqBot ? sessionStorage : localStorage).getItem(key),
    setItem: (key, value) => (window.pqBot ? sessionStorage : localStorage).setItem(key, value),
    removeItem: (key) => (window.pqBot ? sessionStorage : localStorage).removeItem(key)
};

// Server truth: id of the game we are currently in (mirrors ClientStateChanged.game_id).
// Lives on window so top-level handlers (handleRefresh) and commands.js (RefreshData)
// can no-op when there is no active game. Set in the ClientStateChanged handler,
// cleared in onGameEnded. Memory-only on purpose: a reload must re-learn it from
// the server, never trust a stale id.
window.pqGameId = null;

// i18n helper (i18n.js defines window.i18n + window.t).
const t = (key) => (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key) : String(key ?? '');

// Sequence number tracking for CanAnswer/PlayerStoppedAnswering messages.
// Helps discard stale messages that arrive out of order due to network latency.
let lastCanAnswerSequenceNumber = -1;

/**
 * Check if a CanAnswer/PlayerStoppedAnswering message should be processed.
 * @param {number|undefined} sequenceNumber - The sequence number from the message
 * @returns {boolean} - True if message should be processed, false if it's stale
 */
function shouldProcessCanAnswerMessage(sequenceNumber) {
    // If no sequence number provided (old server), always process
    if (sequenceNumber === undefined || sequenceNumber === null) {
        return true;
    }

    // Ignore messages with sequence number less than or equal to already received
    if (sequenceNumber <= lastCanAnswerSequenceNumber) {
        console.log(`Ignoring stale CanAnswer message (seq: ${sequenceNumber}, last: ${lastCanAnswerSequenceNumber})`);
        return false;
    }

    // Update the last sequence number and process
    lastCanAnswerSequenceNumber = sequenceNumber;
    console.log(`Processing CanAnswer message (seq: ${sequenceNumber})`);
    return true;
}

/**
 * Reset the CanAnswer sequence tracker and the answering latch
 * (e.g., when starting or continuing a game).
 */
function resetAnsweringTracking() {
    lastCanAnswerSequenceNumber = -1;
    answeringSeq = -1;
    isInAnsweringState = false;
    console.log('Reset answering tracking (sequence number + answering latch)');
}

/**
 * CONN-03: Clear stale game state variables on reconnection.
 * Called from onSocketOpen BEFORE any server message processing.
 * NOTE: inGame, gameStarted, reconnectAttempt, startedNewGame are intentionally
 * NOT reset here — they are preserved across reconnect or managed by onSocketOpen.
 * The page state cursor (current visible page) is also preserved so the player
 * sees the correct screen; it will be overwritten when the host sends the next
 * game-state message.
 */
function resetGameState() {
    resetAnsweringTracking();
}

// Store keys; we translate them after i18n is ready (see window.onload).
var cameras = ['overall', 'question_close_up', 'far', 'players_display', 'host_close_up', 'round_result', 'game_result', 'whole_studio'];
const ERROR_POPUP_AUTO_HIDE_MS = 5000;
const ERROR_POPUP_DEFAULT_MESSAGE = 'Something went wrong. Please try again.';

let errorPopupElements = null;
let errorPopupAutoHideTimer = null;
let isInAnsweringState = false;
let answeringSeq = -1;

function InitPages() {
    document.addEventListener("keypress", function (event) {
        if (event.key !== "Enter") return;

        var playerAnswerButton = document.getElementById("player_answer_input_button");
        var canAnswer = document.getElementById('you_answer_group').hidden == false;
        if (canAnswer) playerAnswerButton.click();

        var playerGuessButton = document.getElementById("revealing_clues_button");
        var canGuess = document.getElementById('guess_or_pass_player_group').hidden == false;
        if (canGuess) playerGuessButton.click();
    });

    window.auction = {
        update(highestBidderId, highestBid, yourPoints, youPass, yourTurn) {
            this.notEnoughPoints = yourPoints <= highestBid;
            this.youPass = youPass;
            this.yourTurn = yourTurn;
            if (highestBid > 0) {
                this.highestBid = highestBid;
                this.youAreHighestBidder = window.playerId == highestBidderId;
                this.canBid = !auction.youAreHighestBidder && !auction.notEnoughPoints && !auction.youPass && auction.yourTurn;
            } else {
                this.highestBid = 0;
                this.youAreHighestBidder = false;
                this.canBid = !auction.notEnoughPoints && !auction.youPass && auction.yourTurn;
            }
        }
    };

    window.auctionPage = {
        highestBidder: document.getElementById('highest_bidder'),
        highestBid: document.getElementById('highest_bid'),
        yourBid: document.getElementById('your_bid'),
        stepper: document.getElementById('pq_bid_stepper'),
        buttonBid: document.getElementById('button_bid'),
        buttonPass: document.getElementById('button_pass'),
        youAreHighestBidder: document.getElementById('you_are_highest_bidder'),
        notEnoughPoints: document.getElementById('not_enough_points'),
        passing: document.getElementById('passing'),

        enableControls() {
            this.yourBid.disabled = false;
            this.buttonBid.disabled = false;
            this.buttonPass.disabled = false;
            // The two step buttons are NOT re-enabled here: which of them is live depends on
            // where the current bid sits on the ladder, and pqBidSyncStepper() owns that.
        },

        disableControls() {
            this.yourBid.disabled = true;
            this.buttonBid.disabled = true;
            this.buttonPass.disabled = true;
            var minus = document.getElementById('pq_bid_minus');
            var plus = document.getElementById('pq_bid_plus');
            if (minus) minus.disabled = true;
            if (plus) plus.disabled = true;
        },

        onBidClicked(auction) {
            // A typed value can be anything; the ladder is applied before the bid leaves the
            // phone, so the host never receives an off-ladder number.
            if (window.pqBidNormalize) window.pqBidNormalize();
            this.disableControls();
            let bid = this.yourBid.value;
            if (bid == null) return;
            MakeBid(bid, auction.highestBid);
        },

        onPassClicked() {
            this.disableControls();
            AuctionPass();
        },

        update(auction, yourScore, highestBidderName) {
            this.enableControls();
            this.highestBidder.textContent = highestBidderName ? t('highest_bidder') + ' ' + highestBidderName : '';
            this.highestBid.textContent = auction.highestBid > 0 ? auction.highestBid : '';
            // AuctionProcessor sends BidderName = string.Empty until someone bids; without this
            // the gold strip renders as a bare band above the stepper for the whole opening round.
            var leader = this.highestBidder.parentElement;
            if (leader) leader.hidden = !this.highestBidder.textContent && !this.highestBid.textContent;
            // highestBid + 1 is the host's rule ("outbid the leader"); the ladder turns it
            // into the first reachable bid and writes min/max/step/value together.
            if (window.pqBidApply) window.pqBidApply(auction.highestBid + 1, yourScore);
            this.yourBid.hidden = !auction.canBid;
            if (this.stepper) this.stepper.hidden = !auction.canBid;
            this.buttonBid.hidden = !auction.canBid;
            this.buttonPass.hidden = !auction.canBid;
            this.youAreHighestBidder.hidden = !auction.youAreHighestBidder;
            this.notEnoughPoints.hidden = !auction.notEnoughPoints || auction.youPass || auction.youAreHighestBidder;
            this.passing.hidden = !auction.youPass;
        }
    };

    window.auctionHostPage = {
        buttonEndAuction: document.getElementById('button_end_auction'),

        enableControls() {
            this.buttonEndAuction.disabled = false;
        },

        disableControls() {
            this.buttonEndAuction.disabled = true;
        },

        onEndAuction() {
            this.disableControls();
            EndAuction();
        }
    };

    // The field is editable, so the ladder has to survive typing too. 'input' is deliberately
    // not used — it would rewrite the number under the player's finger mid-entry.
    var bidInput = document.getElementById('your_bid');
    if (bidInput) {
        var snapBid = function () { if (window.pqBidNormalize) window.pqBidNormalize(); };
        bidInput.addEventListener('change', snapBid);
        bidInput.addEventListener('blur', snapBid);
    }
}

function runWhenI18nReady(fn) {
    try {
        if (window.i18n && window.i18n.ready && typeof window.i18n.ready.then === 'function') {
            window.i18n.ready.then(fn).catch(fn);
            return;
        }
    } catch (e) {
        // ignore
    }
    fn();
}

function autoFitButtons(root) {
    var container = root || document;
    var buttons = container.querySelectorAll('.button');
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        if (!btn.offsetParent && !root) continue;
        var cs = getComputedStyle(btn);
        var fontSize = parseFloat(cs.fontSize);
        var minSize = 9;
        var isNowrap = cs.whiteSpace === 'nowrap';
        if (isNowrap) {
            while (btn.scrollWidth > btn.clientWidth + 1 && fontSize > minSize) {
                fontSize -= 0.5;
                btn.style.fontSize = fontSize + 'px';
            }
        } else {
            while (btn.scrollHeight > btn.clientHeight + 1 && fontSize > minSize) {
                fontSize -= 0.5;
                btn.style.fontSize = fontSize + 'px';
            }
        }
    }
}

function clearInlineError(id) {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
}

function clearAllInlineErrors() {
    // Legacy inline errors; keep them cleared so errors are centralized in the popup.
    clearInlineError('error_label');
    clearInlineError('role_set_error');
    clearInlineError('info_set_error');
    clearInlineError('custom_avatar_error');
}

window.onload = () => runWhenI18nReady(() => {
    // Translate camera labels now that lang.json is loaded.
    cameras = cameras.map(k => t(k));

    inGame = false;
    gameStarted = false;
    createdCameraButtons = false;
    connecting = false;
    reconnectAttempt = 0;
    preventSelection(document);
    startedNewGame = false;

    InitPages();
    createSocket();
    InitGameIdInput();
    InitErrorPopup();
    autoFitButtons();

    checkTooltipDismissed();

    // ===== State Machine =====
    let currentState = null;

    // ---------- Team mode client state ----------
    window.teamMode = false;
    window.teams = [];            // latest enriched TeamListUpdated.Teams
    var MAX_TEAMS = 10;           // mirrors host MAX_NORMAL_PLAYERS_COUNT / TeamRegistry team limit
    window.myTeam = null;         // the team object containing window.playerId, or null
    window.amCaptain = false;
    window.teamGameInProgress = false; // server truth: locks team switching mid-game (survives refresh)
    window.myMemberName = '';     // display name this client uses inside a team
    window.teamSuggestions = [];   // latest TeamSuggestionsUpdated.Items: [{ActorName, Status, Value}]
    window.teamPressed = {};       // names from TeamMemberPressed, cleared with the suggestions

    // t() has no interpolation; do a minimal {name} replace for team strings.
    function tf(key, vars) {
        var s = t(key);
        if (!vars) return s;
        return s.replace(/\{(\w+)\}/g, function (_, k) {
            return (vars[k] != null) ? String(vars[k]) : '';
        });
    }
    window.tf = tf;

    function recomputeMyTeam() {
        var me = window.playerId;
        window.myTeam = (window.teams || []).find(function (t) {
            return (t.Members || []).some(function (m) { return m.Id === me; });
        }) || null;
        window.amCaptain = !!(window.myTeam && window.myTeam.CaptainId === me);
        if (typeof updateCaptainBadge === 'function') updateCaptainBadge();
    }

    // In team mode, returns the team screen for the current player's role; null if not team mode.
    function teamScreenFor(captainState, teammateState) {
        if (!window.teamMode) return null;
        return window.amCaptain ? captainState : teammateState;
    }
    window.teamScreenFor = teamScreenFor;

    var _teamToastTimer = null;
    function showTeamToast(name) {
        var el = document.getElementById('team_toast');
        if (!el) return;
        el.textContent = tf('member_pressed', { name: name || '' });
        el.hidden = false;
        void el.offsetWidth;
        el.classList.add('visible');
        if (_teamToastTimer) clearTimeout(_teamToastTimer);
        _teamToastTimer = setTimeout(function () {
            el.classList.remove('visible');
            setTimeout(function () { el.hidden = true; }, 250);
        }, 1800);
    }
    window.showTeamToast = showTeamToast;

    // Screens where the suggestion strip is allowed to show. Used to keep it from lingering on
    // unrelated screens when a TeamSuggestionsUpdated arrives out of band.
    var SUGG_STATES = ['TEAMMATE_SUGGEST', 'CAN_ANSWER', 'YOU_ANSWER', 'MULTIPLE_CHOICE_PLAYER', 'REVEALING_CLUES_PLAYER', 'NUMBER_GUESS_PLAYER', 'FINAL_ROUND_ANSWERING_PLAYER'];

    // Each answering screen has its own input, so a picked suggestion must land in the one
    // the captain is actually looking at.
    var ANSWER_INPUT_BY_STATE = {
        REVEALING_CLUES_PLAYER: 'revealing_clues_input',
        FINAL_ROUND_ANSWERING_PLAYER: 'final_answer_input',
    };

    function renderSuggestions() {
        var list = document.getElementById('sugg_list');
        var strip = document.getElementById('sugg_strip');
        if (!list || !strip) return;

        // Shown to EVERY team member (captain + teammates), so everyone sees all suggestions
        // including their own. Only the captain is excluded from the rows.
        if (!window.teamMode || !window.myTeam) { strip.hidden = true; return; }

        // Base the list on the team roster minus the captain, so once the strip is up every
        // teammate has a row (spinner until they send). Submitted values overlay on top.
        var captainId = window.myTeam.CaptainId;
        var members = (window.myTeam.Members || []).filter(function (m) { return m.Id !== captainId; });
        if (members.length === 0) { strip.hidden = true; return; }

        var submittedById = {};
        var submittedCount = 0;
        (window.teamSuggestions || []).forEach(function (it) {
            if (it && it.Status === 'submitted') {
                submittedById[it.Id] = (it.Value != null ? it.Value : '');
                submittedCount++;
            }
        });

        // "Waiting for suggestions" with nothing to wait on is noise: the strip appeared the
        // moment the question did and sat there as a column of spinners for the whole
        // question if nobody typed. It earns its place with the first buzz or submission —
        // a team-mate pressing the button is exactly when the captain starts waiting.
        var pressedCount = Object.keys(window.teamPressed || {}).length;
        if (submittedCount === 0 && pressedCount === 0) { strip.hidden = true; list.innerHTML = ''; return; }

        list.innerHTML = '';
        members.forEach(function (m) {
            var row = document.createElement('div');
            row.className = 'sugg';

            var nm = document.createElement('span');
            nm.className = 'name';
            nm.textContent = m.Name || '…';
            row.appendChild(nm);

            if (Object.prototype.hasOwnProperty.call(submittedById, m.Id)) {
                var picked = submittedById[m.Id];
                var val = document.createElement('span');
                val.className = 'value';
                val.textContent = picked;
                row.appendChild(val);

                // Captain can drop a teammate's suggestion into the answer field — via an explicit
                // icon button, or by tapping the row.
                if (window.amCaptain) {
                    row.classList.add('pickable');
                    var usePick = function (p) {
                        return function (e) {
                            if (e) e.stopPropagation();
                            if (currentState === 'MULTIPLE_CHOICE_PLAYER') {
                                applySuggestionToMultipleChoice(p);
                                return;
                            }
                            if (currentState === 'NUMBER_GUESS_PLAYER') {
                                var digits = String(p).replace(/[^\d]/g, '');
                                var guessInput = document.getElementById('number_guess_input');
                                if (digits && guessInput) { guessInput.value = digits; guessInput.focus(); }
                                return;
                            }
                            var ans = document.getElementById(ANSWER_INPUT_BY_STATE[currentState] || 'player_answer_input');
                            if (ans) { ans.value = p; ans.focus(); }
                        };
                    }(picked);

                    var pick = document.createElement('button');
                    pick.type = 'button';
                    pick.className = 'sugg-pick';
                    pick.textContent = '⤵';
                    var useWord = t('use_suggestion');
                    pick.title = (useWord === 'use_suggestion') ? 'Use' : useWord;
                    pick.addEventListener('click', usePick);
                    row.appendChild(pick);

                    row.addEventListener('click', usePick);
                }
            } else {
                var sp = document.createElement('span');
                sp.className = 'spinner';
                row.appendChild(sp);
            }
            list.appendChild(row);
        });
        strip.hidden = false;
    }
    window.renderSuggestions = renderSuggestions;

    // Captain taps a teammate's suggestion during multiple choice: vote the option
    // whose text matches the suggestion (exact first, then substring either way).
    function applySuggestionToMultipleChoice(text) {
        if (window._mcVoted) return;
        var options = window._mcOptions || [];
        var needle = String(text || '').trim().toLowerCase();
        if (!needle) return;

        var idx = -1;
        for (var i = 0; i < options.length; i++) {
            if (String(options[i]).trim().toLowerCase() === needle) { idx = i; break; }
        }
        if (idx === -1) {
            for (var j = 0; j < options.length; j++) {
                var option = String(options[j]).trim().toLowerCase();
                if (option && (option.indexOf(needle) !== -1 || needle.indexOf(option) !== -1)) { idx = j; break; }
            }
        }
        if (idx === -1) return;

        window._mcVoted = true;
        MultipleChoiceVote(idx);

        var group = document.getElementById('multiple_choice_options_group');
        if (group && group.children[idx]) group.children[idx].classList.add('is-picked');
    }

    // Role line in team mode: captain or member + team name. The header strip carries the
    // score and the current question only, so this fact lives in #captain_badge again — shown
    // exactly when there is something to say (team mode with a team), hidden otherwise.
    function updateCaptainBadge() {
        var badge = document.getElementById('captain_badge');

        var text = '';
        if (window.teamMode && window.myTeam) {
            var key = window.amCaptain ? 'you_are_captain' : 'you_are_member';
            var word = t(key);
            if (word === key) word = window.amCaptain ? 'Captain' : 'Member'; // locale missing key → English
            var icon = window.amCaptain ? '👑' : '👤';
            var teamName = (window.myTeam && window.myTeam.Name) ? window.myTeam.Name : '';
            text = icon + ' ' + [word, teamName].filter(Boolean).join(' · ');
        }

        if (!badge) return;
        var badgeText = document.getElementById('captain_badge_text');
        if (badgeText) badgeText.textContent = text;
        badge.hidden = !text;
    }
    window.updateCaptainBadge = updateCaptainBadge;

    function hideSuggStrip() {
        var s = document.getElementById('sugg_strip');
        if (s) s.hidden = true;
    }
    window.hideSuggStrip = hideSuggStrip;

    function resetTeamSuggestions() {
        window.teamSuggestions = [];
        window.teamPressed = {};
        renderSuggestions();
    }
    window.resetTeamSuggestions = resetTeamSuggestions;

    function SubmitTeammateSuggestion() {
        var input = document.getElementById('teammate_suggest_input');
        var value = input ? (input.value || '').trim() : '';
        if (!value) return;
        SubmitSuggestion(value);
        if (input) input.value = '';
        var label = document.getElementById('teammate_suggest_label');
        if (label) label.textContent = t('answer_submitted');
    }
    window.SubmitTeammateSuggestion = SubmitTeammateSuggestion;

    function memberNamesPreview(team) {
        var names = (team.Members || []).map(function (m) { return m.Name || '…'; });
        if (names.length <= 3) return names.join(' · ');
        return names.slice(0, 3).join(' · ') + ' · +' + (names.length - 3);
    }

    function teamAvatarEl(avatarFile) {
        var img = document.createElement('img');
        img.className = 'avatar avatar-sm';
        if (avatarFile && avatarFile !== 'custom_avatar')
            img.src = '../../avatars/' + avatarFile;
        return img;
    }

    function renderTeamList() {
        var container = document.getElementById('team_list');
        if (!container) return;
        container.innerHTML = '';

        var sub = document.getElementById('team_lobby_sub');
        var createBtn = document.getElementById('team_create_btn');

        // Already in a team: show team name + every member (captain marked, you highlighted).
        if (window.myTeam) {
            if (sub) sub.hidden = true;
            if (createBtn) createBtn.hidden = true;

            var card = document.createElement('div');
            card.className = 'team-row team-row-self';
            card.appendChild(teamAvatarEl(window.myTeam.Avatar));

            var cMeta = document.createElement('div');
            cMeta.className = 'meta';

            var cName = document.createElement('div');
            cName.className = 'team-name-big';
            cName.textContent = window.myTeam.Name || '';
            cMeta.appendChild(cName);

            var membersLabel = document.createElement('div');
            membersLabel.className = 'members-label';
            membersLabel.textContent = t('team_members');
            cMeta.appendChild(membersLabel);

            var members = window.myTeam.Members || [];
            var captainId = window.myTeam.CaptainId;
            for (var mi = 0; mi < members.length; mi++) {
                var m = members[mi];
                var row = document.createElement('div');
                row.className = 'member';
                if (m.Id === captainId) row.classList.add('captain');
                if (m.Id === window.playerId) row.classList.add('me');
                row.textContent = m.Name || '…';
                cMeta.appendChild(row);
            }

            card.appendChild(cMeta);
            container.appendChild(card);

            // No team switching once the game is underway — locks roster mid-game. Uses server truth
            // (teamGameInProgress) so it holds after a browser refresh, when gameStarted resets to false.
            if (!gameStarted && !window.teamGameInProgress) {
                var change = document.createElement('button');
                change.className = 'button color-red';
                change.style.marginTop = '10px';
                change.textContent = t('change_team');
                change.onclick = function () { LeaveTeam(); };
                container.appendChild(change);
            }
            return;
        }

        // Not in a team: selectable team list + create. (Name set in ENTER_MEMBER_NAME.)
        if (sub) sub.hidden = false;

        var browserTeams = (window.teams || []);
        // At the team cap you can only join an existing team — hide the create button.
        if (createBtn) createBtn.hidden = browserTeams.length >= MAX_TEAMS;
        for (var i = 0; i < browserTeams.length; i++) {
            (function (team) {
                var row = document.createElement('div');
                row.className = 'team-row';
                row.appendChild(teamAvatarEl(team.Avatar));

                var meta = document.createElement('div');
                meta.className = 'meta';
                var nm = document.createElement('div');
                nm.className = 'name';
                nm.textContent = team.Name || '';
                var mem = document.createElement('div');
                mem.className = 'members';
                mem.textContent = memberNamesPreview(team);
                meta.appendChild(nm); meta.appendChild(mem);

                var btn = document.createElement('button');
                btn.className = 'button color-blue team-join-btn';
                btn.textContent = t('join');
                btn.onclick = function () { JoinTeamChecked(team.TeamId); };

                row.appendChild(meta); row.appendChild(btn);
                container.appendChild(row);
            })(browserTeams[i]);
        }
    }

    function StartTeamCreate() {
        if ((window.teams || []).length >= MAX_TEAMS) { reportError(t('team_limit_reached')); return; }
        goTo('TEAM_CREATE');
    }

    async function ConfirmCreateTeam() {
        var name = (document.getElementById('team_name_input').value || '').trim();
        if (!name) { reportError(t('team_name_required')); return; }
        if (!window.myMemberName) { reportError(t('enter_your_name')); return; }
        if ((window.teams || []).length >= MAX_TEAMS) { reportError(t('team_limit_reached')); return; }
        var avatar = (typeof avatars !== 'undefined' && avatars.length)
            ? avatars[currentAvatarIndex] : '';

        // The team avatar can be custom — mirror SetInfo: upload the image (chunked) first, then send
        // meta-only. The host reuses the uploaded image for the team player.
        var allowCustom = (window.allowCustomAvatars !== false);
        var isCustomSelected = allowCustom && window.customAvatar && avatar === window.customAvatar.id;
        var fullPayload = (window.customAvatar && window.customAvatar.payload && window.customAvatar.payload.Data)
            ? window.customAvatar.payload : undefined;
        var customAvatarPayload = undefined;
        if (isCustomSelected && fullPayload) {
            try {
                await uploadCustomAvatarIfNeeded(fullPayload);
                customAvatarPayload = customAvatarMetaOnly(fullPayload);
            } catch (e) {
                console.error(e);
                reportError("Unable to upload custom team avatar. Try again.");
                return;
            }
        }

        CreateTeam(name, avatar, customAvatarPayload);
        goTo('TEAM_LOBBY');
    }

    function OnMemberNameInput(v) { window.myMemberName = (v || '').trim(); }

    function JoinTeamChecked(teamId) {
        if (!window.myMemberName) { reportError(t('enter_your_name')); return; }
        JoinTeam(teamId, window.myMemberName);
    }

    function InitTeamLobby() {
        renderTeamList();
    }

    function InitMemberNameScreen() {
        if (!window.myMemberName) {
            try { window.myMemberName = (window.pqStore.getItem('name') || '').trim(); } catch (e) { /* ignore */ }
        }
        var input = document.getElementById('member_name_input');
        if (input) input.value = window.myMemberName || '';
    }

    function ConfirmMemberName() {
        var name = (document.getElementById('member_name_input').value || '').trim();
        if (!name) { reportError(t('enter_your_name')); return; }
        window.myMemberName = name;
        goTo('TEAM_LOBBY');
    }

    window.StartTeamCreate = StartTeamCreate;
    window.ConfirmCreateTeam = ConfirmCreateTeam;
    window.renderTeamList = renderTeamList;
    window.OnMemberNameInput = OnMemberNameInput;
    window.JoinTeamChecked = JoinTeamChecked;
    window.InitTeamLobby = InitTeamLobby;
    window.InitMemberNameScreen = InitMemberNameScreen;
    window.ConfirmMemberName = ConfirmMemberName;

    // Display name of whoever currently picks questions. The host sends it with every
    // StartGame / ContinueGame, and it is the same person the cat-in-a-poke waiting card
    // has to name — StartCatInPoke itself carries no name.
    var pqSelectorName = '';

    // The waiting card names the picker. Locales that still carry the old nameless value
    // have no {name} token, so tf() leaves their sentence untouched and it still reads
    // correctly; with no name known at all we fall back to a nameless line.
    // Seeing this card while the selector is *me* means the quiz host is the one picking
    // (the host-only cat setting), and StartCatInPoke does not say who that is — so the
    // name is dropped rather than guessed wrong.
    function setCatInPokeWaitLabel() {
        var el = document.getElementById('cat_in_poke_wait_label');
        if (!el) return;
        var myName = '';
        try { myName = (window.pqStore.getItem('name') || '').trim(); } catch (e) { myName = ''; }
        var name = (pqSelectorName && pqSelectorName !== myName) ? pqSelectorName : '';
        el.textContent = name
            ? tf('selecting_cat_in_poke_victim', { name: name })
            : t('WHO GETS THE CAT?');
    }

    // 'question_selected_group' is the one home of the theme and the price. Every state that
    // happens while a question is in flight lists it, for both roles; the board, the lobby,
    // the results and the standings do not. Where the host never sends the two facts
    // (multiple choice, number guess, revealing clues) the panel simply stays empty and
    // refreshQuestionMeta() hides it again — no state renders either fact anywhere else.
    const PAGE_STATES = {
        ENTER_ID: {
            title: () => t('join_game'),
            show: ['enter_id_group']
        },
RESUME_GAME: {
            title: () => t('resume_game'),
            show: ['resume_game_group']
        },
        ROLE_SELECTION: {
            title: () => t('choose_your_role'),
            show: ['role_selection_group']
        },
        SET_INFO: {
            title: () => t('set_info'),
            show: ['avatar_group', 'set_info_group'],
            onEnter: () => { InitAvatars(); initSetInfoChangeTracking(); }
        },
        ENTER_MEMBER_NAME: {
            title: () => t('your_name'),
            show: ['enter_member_name_group'],
            onEnter: () => { InitMemberNameScreen(); }
        },
        TEAM_LOBBY: {
            title: () => t('teams'),
            show: ['team_lobby_group'],
            onEnter: () => { InitTeamLobby(); }
        },
        TEAM_CREATE: {
            title: () => t('new_team'),
            show: ['avatar_group', 'team_create_group'],
            onEnter: () => { InitAvatars(); }
        },
        // Both team-mate states own their headline inside their own panel, so neither writes
        // #title: the shared title strip was printing the very same sentence a second time
        // above the card. The panel is the one home of the line, exactly as the number-guess
        // eyebrow was folded into its field last round.
        TEAMMATE_READONLY: {
            title: '',
            show: ['question_selected_group', 'teammate_readonly_group'],
            onEnter: (d) => {
                // The headline carries the reason; the note stays the standing explanation,
                // so the card never says the same thing on both of its lines either.
                var head = document.getElementById('teammate_readonly_title');
                if (head) head.textContent = (d && d.cantAnswer) ? t('you_cant_answer_now') : t('captain_decides_short');
                var note = document.getElementById('teammate_readonly_note');
                if (note) note.textContent = t('captain_decides');
            }
        },
        TEAMMATE_SUGGEST: {
            // Buzz mode gets the same headline in the same place as the captain's CAN_ANSWER
            // screen; only the suggestion mode owns its line inside the card.
            title: (d) => (d && d.showBuzzer) ? t('press_if_you_know_the_answer') : '',
            show: ['question_selected_group', 'teammate_suggest_group'],
            onEnter: (d) => {
                // Buzz mode (button not pressed yet): only the buzzer — no suggestion field, no list.
                // Suggest mode (team already buzzed in): suggestion field + list, no buzzer.
                var buzzMode = !!(d && d.showBuzzer);
                var buzz = document.getElementById('teammate_buzzer');
                if (buzz) buzz.hidden = !buzzMode;
                // The call to action is the headline in buzz mode, so the note would only
                // repeat the screen; it carries the captain line while a suggestion is open.
                // Queried by class as well as by id: game.html itself has no ?v, so a phone
                // can be running new JS against markup it cached before the id existed.
                var note = document.getElementById('teammate_suggest_note')
                    || document.querySelector('#teammate_suggest_group .teammate-note');
                if (note) {
                    note.hidden = buzzMode;
                    note.textContent = t('captain_decides');
                }
                // The shell carries the ring and its own vertical margin, so it is what goes
                // away in suggest mode — hiding the button alone left a 36px gap and a ring
                // pulsing over nothing.
                var shell = document.getElementById('teammate_buzz_shell');
                if (shell) shell.hidden = !buzzMode;
                var entry = document.getElementById('teammate_suggest_entry');
                if (entry) entry.hidden = buzzMode;

                if (buzzMode) {
                    hideSuggStrip();
                } else {
                    var label = document.getElementById('teammate_suggest_label');
                    if (label) label.textContent = (d && d.label) ? t(d.label) : t('your_suggestion');
                    var input = document.getElementById('teammate_suggest_input');
                    if (input) input.value = '';
                    renderSuggestions();
                }
            }
        },
        SELECT_QUESTION_HOST: {
            title: () => t('select_the_question'),
            show: ['select_question_host_group'],
            onEnter: (d) => {
                // Back on the board: the previous question's price is stale, and so is its
                // synergy — there is no question for a multiplier to apply to. Without this
                // a dropped SynergyChanged{false} would rain over the board for ever.
                clearQuestionContext();
                if (d && d.themes) CreateQuestionsFromJson(d.themes);
            }
        },
        SELECT_QUESTION_PLAYER: {
            title: (d) => d.selector + ' ' + t('selects_the_question'),
            show: [],
            onEnter: () => { clearQuestionContext(); }
        },
        QUESTION_SELECTED: {
            show: ['question_selected_group'],
            onEnter: (d) => {
                if (window.pqStore.getItem('role') === 'host')
                    document.getElementById('right_answer_group').hidden = false;
                setQuestionMeta(d && d.Theme, d && d.Price);
            }
        },
        GET_READY: {
            title: () => t('READY...STEADY...'),
            show: ['question_selected_group', 'get_ready_player_group']
        },
        CAN_ANSWER: {
            // Title as a function (not only written in onEnter) so the
            // pq:languageChanged listener can re-translate .topic-block without
            // re-running onEnter. onEnter keeps the button/strip side-effects.
            title: (d) => (d && (d.triedToAnswer || d.wasCorrect))
                ? t("you_cant_answer_now")
                : t('press_if_you_know_the_answer'),
            show: ['question_selected_group', 'can_answer_player_group'],
            onEnter: (d) => {
                if (d && (d.triedToAnswer || d.wasCorrect)) {
                    document.getElementById('title').textContent = t("you_cant_answer_now");
                    document.getElementById('answer_button').hidden = true;
                    hideSuggStrip();
                } else {
                    document.getElementById('title').textContent = t('press_if_you_know_the_answer');
                    document.getElementById('answer_button').hidden = false;
                    renderSuggestions();
                }
            }
        },
        PLAYER_ANSWERS_HOST: {
            title: '',
            show: ['question_selected_group', 'player_answers_host_group', 'right_answer_group'],
            onEnter: (d) => {
                document.getElementById('answering_player').textContent = d.player;
                SetAnswerDecisionButtonsEnabled(true);

                if (d.answer)
                    document.getElementById('right_answer').textContent = d.answer;
            }
        },
        YOU_ANSWER: {
            title: () => t('YOU ANSWER!'),
            show: ['question_selected_group', 'you_answer_group'],
            onEnter: () => { renderSuggestions(); }
        },
        ALL_QUESTIONS_ANSWERED_HOST: {
            show: ['all_questions_answered_host_group'],
            onEnter: () => { renderStandings(); }
        },
        ALL_QUESTIONS_ANSWERED_PLAYER: {
            show: ['all_questions_answered_player_group'],
            onEnter: () => { renderStandings(); }
        },
        CAT_IN_POKE_HOST: {
            title: () => t('WHO GETS THE CAT?'),
            show: ['question_selected_group', 'cat_in_poke_host_group'],
            onEnter: (d) => CreatePlayersForCatInPoke(d.Players)
        },
        CAT_IN_POKE_PLAYER: {
            title: () => t('CAT IN A POKE SELECTION'),
            show: ['question_selected_group', 'cat_in_poke_player_group'],
            onEnter: () => { ClearCatInPokeTable(); setCatInPokeWaitLabel(); }
        },
        FINAL_ROUND_THEMES_HOST: {
            title: () => t('REMOVE THEMES'),
            show: ['final_round_themes_group'],
            onEnter: (d) => {
                CreateThemesForLastRound(d.themes);
                if (d.playerName) document.getElementById('undertitle').textContent = d.playerName;
            }
        },
        FINAL_ROUND_THEMES_PLAYER: {
            title: () => t("WHICH THEME YOU DON'T LIKE?")
        },
        INTRODUCE_THEMES: {
            title: () => t('SELECT AND INTRODUCE A TOPIC'),
            show: ['themes_to_introduce_group'],
            onEnter: (d) => CreateTopicsToIntroduceList(d.themes)
        },
        SEQUENCE_PLAYER: {
            title: () => t('LOOK AT THE SCREEN'),
            show: ['question_selected_group']
        },
        SEQUENCE_HOST: {
            title: () => t('LOOK AT THE SCREEN'),
            show: ['question_selected_group', 'skip_displaying_group']
        },
        CURIOSITY: {
            title: () => t('CHOOSE THEME'),
            show: ['final_round_themes_group'],
            onEnter: (d) => CreateThemesForCuriosity(d.themes)
        },
        CONTINUE_OR_END: {
            title: () => t('CURIOUS OR END'),
            show: ['curiosity_or_end_group']
        },
        DISPLAY_CURIOSITY_ANSWER: {
            title: '',
            show: ['curiosity_answer_group']
        },
        NOT_ENOUGH_POINTS: {
            title: () => t("YOU DON'T HAVE ENOUGH POINTS TO BID")
        },
        FINAL_BID_CONFIRMED: {
            title: () => t('YOUR BID HAS BEEN MADE'),
            undertitle: (d) => '(' + t("IT'S") + ' ' + d.bid + ' )'
        },
        FINAL_ROUND_ANSWERING_HOST: {
            title: () => t('EVERYONE IS ANSWERING NOW'),
            show: ['everyone_answers_group']
        },
        FINAL_ROUND_ANSWERING_PLAYER: {
            title: () => t('NOW ANSWER THE QUESTION'),
            undertitle: (d) => '(' + t('YOUR BID IS') + ' ' + d.bid + ' )',
            show: ['final_round_answer_group'],
            onEnter: () => { renderSuggestions(); }
        },
        FINAL_ROUND_ANSWER_CONFIRMED: {
            title: () => t('YOUR ANSWER HAS BEEN ACCEPTED'),
            undertitle: (d) => '(' + d.answer + ')'
        },
        FINAL_ROUND_DECIDE_ANSWER: {
            title: () => t('WAS THE ANSWER CORRECT?'),
            show: ['final_round_decide_answer_group'],
            onEnter: (d) => {
                document.getElementById('final_round_answering_player').textContent = d.PlayerName;
                document.getElementById('final_round_player_answer').textContent = d.PlayerAnswer;
                document.getElementById('final_round_answer').textContent = d.RightAnswer;
            }
        },
        FINAL_BID_HOST: {
            title: () => t('EVERYONE IS BIDDING NOW'),
            show: ['everyone_bids_group']
        },
        FINAL_BID_PLAYER: {
            title: () => t("WHAT'S YOUR BID?"),
            undertitle: (d) => t('YOUR SCORE:') + ' ' + d.MaxBid,
            show: ['final_bid_player_group'],
            onEnter: (d) => { document.getElementById('final_bid_label').textContent = d.ThemeName; }
        },
        AUCTION_HOST: {
            title: () => t('AUCTION'),
            show: ['question_selected_group', 'auction_host_group'],
            onEnter: () => window.auctionHostPage.enableControls()
        },
        AUCTION_PLAYER: {
            title: () => t('AUCTION'),
            show: ['question_selected_group', 'auction_player_group'],
            onEnter: (d) => UpdateAuctionPlayerPage(d.BidderId, d.BidderName, d.Bid, d.YourScore, d.YouPass, d.YourTurn)
        },
        MULTIPLE_CHOICE_HOST: {
            title: () => t('VOTING IN PROGRESS'),
            show: ['question_selected_group', 'multiple_choice_host_group']
        },
        MULTIPLE_CHOICE_PLAYER: {
            title: (d) => d && d.question ? d.question : '',
            show: ['question_selected_group', 'multiple_choice_options_group'],
            onEnter: (d) => {
                window._mcOptions = (d && d.options) || [];
                window._mcVoted = false;
                CreateMultipleChoiceOptions(d.options);
                renderSuggestions();
            }
        },
        VOTE_ACCEPTED: {
            title: () => t('YOUR VOTE HAS BEEN ACCEPTED'),
            show: ['question_selected_group']
        },
        NUMBER_GUESS_HOST: {
            title: () => t('GUESSING IN PROGRESS'),
            show: ['question_selected_group', 'number_guess_host_group']
        },
        NUMBER_GUESS_PLAYER: {
            title: () => t('GUESS THE NUMBER'),
            show: ['question_selected_group', 'number_guess_player_group'],
            onEnter: (d) => {
                var input = document.getElementById('number_guess_input');
                if (input) {
                    input.value = '';
                    input.min = d && d.min != null ? d.min : 0;
                }
                renderSuggestions();
            }
        },
        GUESS_ACCEPTED: {
            title: () => t('YOUR GUESS HAS BEEN ACCEPTED'),
            show: ['question_selected_group']
        },
        DECIDE_FINAL_PLAYERS: {
            show: ['decide_final_players_group']
        },
        REVEALING_CLUES_HOST: {
            show: ['question_selected_group', 'stop_guessing_or_end_question_group']
        },
        REVEALING_CLUES_PLAYER: {
            title: (d) => d && d.clue ? d.clue : '',
            show: ['question_selected_group', 'guess_or_pass_player_group'],
            onEnter: (d) => {
                window._rcPassed = false;
                // Nothing follows the last clue, so passing there is only a lost turn.
                var pass = document.getElementById('revealing_clues_pass_button');
                if (pass) pass.hidden = !!(d && d.isLastClue);
                renderSuggestions();
            }
        },
        REVEALING_CLUES_DECIDE: {
            title: () => t('WAS THE ANSWER CORRECT?'),
            show: ['question_selected_group', 'revealing_clues_decide_answer_group'],
            onEnter: (d) => {
                document.getElementById('revealing_clues_answering_player').textContent = d.player;
                document.getElementById('revealing_clues_player_answer').textContent = d.playerAnswer;
                document.getElementById('revealing_clues_right_answer').textContent = d.rightAnswer;
            }
        },
        REVEALING_CLUES_CHOICE_MADE: {
            // The host confirms a guess and a pass with the same message, so what was sent
            // is only known here. Reset on every new clue by REVEALING_CLUES_PLAYER.
            title: () => window._rcPassed ? t('passing') : t('YOUR VOTE HAS BEEN ACCEPTED'),
            show: ['question_selected_group']
        },
        APPLAUSE: {
            title: () => t('clap_title'),
            undertitle: () => t('game_over_clap'),
            show: ['applause_group']
        }
    };

    // Accent family per page state; drives --pq-accent through body[data-pq-screen].
    var PQ_SCREEN_FAMILY = {
        ENTER_ID: 'onboard', RESUME_GAME: 'onboard', ROLE_SELECTION: 'onboard', SET_INFO: 'onboard',
        ENTER_MEMBER_NAME: 'teams', TEAM_LOBBY: 'teams', TEAM_CREATE: 'teams',
        TEAMMATE_READONLY: 'ackwait', SEQUENCE_PLAYER: 'ackwait', SEQUENCE_HOST: 'ackwait',
        FINAL_BID_CONFIRMED: 'ackwait', FINAL_ROUND_ANSWERING_HOST: 'ackwait',
        FINAL_ROUND_ANSWER_CONFIRMED: 'ackwait', VOTE_ACCEPTED: 'ackwait', GUESS_ACCEPTED: 'ackwait',
        REVEALING_CLUES_CHOICE_MADE: 'ackwait',
        TEAMMATE_SUGGEST: 'buzz', GET_READY: 'buzz', CAN_ANSWER: 'buzz',
        SELECT_QUESTION_HOST: 'board', SELECT_QUESTION_PLAYER: 'board', QUESTION_SELECTED: 'board',
        INTRODUCE_THEMES: 'board',
        PLAYER_ANSWERS_HOST: 'judge', CONTINUE_OR_END: 'judge', DISPLAY_CURIOSITY_ANSWER: 'judge',
        FINAL_ROUND_DECIDE_ANSWER: 'judge', MULTIPLE_CHOICE_HOST: 'judge', NUMBER_GUESS_HOST: 'judge',
        REVEALING_CLUES_HOST: 'judge', REVEALING_CLUES_DECIDE: 'judge',
        YOU_ANSWER: 'answer', FINAL_ROUND_ANSWERING_PLAYER: 'answer', MULTIPLE_CHOICE_PLAYER: 'answer',
        NUMBER_GUESS_PLAYER: 'answer', REVEALING_CLUES_PLAYER: 'answer',
        NOT_ENOUGH_POINTS: 'bid', FINAL_BID_HOST: 'bid', FINAL_BID_PLAYER: 'bid',
        AUCTION_HOST: 'bid', AUCTION_PLAYER: 'bid',
        CAT_IN_POKE_HOST: 'pick', CAT_IN_POKE_PLAYER: 'pick', FINAL_ROUND_THEMES_HOST: 'pick',
        FINAL_ROUND_THEMES_PLAYER: 'pick', CURIOSITY: 'pick', DECIDE_FINAL_PLAYERS: 'pick',
        ALL_QUESTIONS_ANSWERED_HOST: 'results', ALL_QUESTIONS_ANSWERED_PLAYER: 'results',
        APPLAUSE: 'results'
    };

    // Состояния, у которых плашка «тема + номинал» обязана быть заполнена: ровно те типы
    // вопроса, что перечислены в QuestionHandler.RequiresQuestionMeta (:460-464). Auction
    // здесь намеренно отсутствует — пока идут торги, номинал вопроса пуст by design
    // (main.js ставит setQuestionMeta(theme, '')).
    var PQ_META_PLAQUE_STATES = {
        MULTIPLE_CHOICE_HOST: 1, MULTIPLE_CHOICE_PLAYER: 1,
        NUMBER_GUESS_HOST: 1, NUMBER_GUESS_PLAYER: 1,
        REVEALING_CLUES_HOST: 1, REVEALING_CLUES_PLAYER: 1,
        CAT_IN_POKE_HOST: 1, CAT_IN_POKE_PLAYER: 1
    };

    // Onboarding and team states carry no score of their own; the strip stays away there.
    var PQ_STRIP_HIDDEN = {
        ENTER_ID: 1, RESUME_GAME: 1, ROLE_SELECTION: 1, SET_INFO: 1,
        ENTER_MEMBER_NAME: 1, TEAM_LOBBY: 1, TEAM_CREATE: 1
    };
    var pqMyScore = 0;
    // Score the local player carried into the current round; the scoreboard delta is the
    // difference against it. Starts at 0 so the first round's delta is that round's gain.
    window.pqRoundStartScore = 0;
    // Baseline in force for the round-result screen currently on display; HideAll clears it.
    var pqDeltaBaseline = null;
    // Confetti latch, one entry per layer. The celebration layer is re-armed by
    // pqCelebrateCorrect() itself rather than by HideAll, because the verdict is followed
    // immediately by a screen change and a HideAll re-arm would wipe the burst a few
    // hundred milliseconds after it started. The synergy layer keeps no latch — it rains
    // for as long as synergy is on, driven by its own interval.
    var pqConfetti = {
        pq_correct_confetti: { done: false, timer: null }
    };
    // Theme and price of the question currently in flight. Both are question facts, not
    // screen facts: they are set from the message that announces the question and survive
    // every screen change until the board clears them. Synergy multiplies what is *shown*;
    // the base price stays here so switching synergy off restores the number exactly.
    var pqThemeLabel = '';
    var pqValueLabel = '';
    // Откуда взялась мета, что сейчас на экране: 'payload' — её поставило сообщение,
    // открывающее панель; 'selected' — она уцелела от выбора вопроса; 'none' — контекст
    // вопроса очищен. Единственное поле, различающее «починено» и «код починки не
    // исполнился ни разу»: значение плашки одинаково в обоих случаях, источник — нет.
    var pqMetaSource = 'none';
    var pqSynergyActive = false;
    var pqSynergyMultiplier = 1;

    function pqIsHost() {
        try { return !!(window.pqStore && window.pqStore.getItem('role') === 'host'); } catch (e) { return false; }
    }

    function setMyScore(value) {
        pqMyScore = (value == null) ? 0 : value;
        var el = document.getElementById('pq_score_value');
        if (el) el.textContent = pqMyScore;
    }

    // null/undefined means "unchanged" — the host re-sends QuestionSelected with no payload
    // several times per question. Pass '' to clear.
    function setQuestionMeta(theme, price, src) {
        // Источник меняется ТОЛЬКО когда мета задана непустой: пустой вызов — это очистка,
        // а не новый источник, и re-send без payload не должен затирать 'payload' на
        // 'selected'.
        var given = (theme != null && String(theme) !== '') || (price != null && String(price) !== '');
        if (theme != null) pqThemeLabel = theme;
        if (price != null) pqValueLabel = price;
        if (given) pqMetaSource = src || 'selected';
        refreshQuestionMeta();
    }

    // Back on the board: there is no current question, so neither its meta nor its synergy
    // multiplier means anything any more.
    function clearQuestionContext() {
        setQuestionMeta('', '');
        // После вызова, а не до: setQuestionMeta на пустой цене источник не обновляет,
        // и присваивание до вызова просто пережило бы очистку.
        pqMetaSource = 'none';
        setSynergy(false, 1);
    }

    // Displayed price: base while synergy is off, base x multiplier while it is on. Rounded,
    // because the multiplier is a float and a fractional nominal reads as a bug.
    function pqDisplayPrice() {
        if (pqValueLabel === '' || pqValueLabel == null) return '';
        var n = Number(pqValueLabel);
        if (!pqSynergyActive || !isFinite(n)) return String(pqValueLabel);
        return String(Math.round(n * pqSynergyMultiplier));
    }

    // One fact, one home: the theme and the price live in #question_selected_group and
    // nowhere else. This is the only writer of either label, so a state can never inherit
    // the previous question's meta, and it runs at the end of every goTo().
    function refreshQuestionMeta() {
        var theme = (pqThemeLabel == null) ? '' : String(pqThemeLabel);
        var price = pqDisplayPrice();
        var synergyOn = pqSynergyActive && price !== '';

        var themeEl = document.getElementById('question_selected_theme');
        if (themeEl) themeEl.textContent = theme;

        var selected = document.getElementById('question_selected_price');
        if (selected) {
            selected.textContent = price;
            selected.classList.toggle('is-synergy', synergyOn);
        }

        // Both labels are data-driven, so with nothing to say the panel would render as a
        // bare band, and a state that owns no meta must never inherit the previous one's.
        // Visibility is decided here in both directions, so meta arriving after the goTo that
        // revealed the panel still shows up — QuestionMeta can land either side of it.
        var group = document.getElementById('question_selected_group');
        if (group) {
            var state = PAGE_STATES[currentState];
            var wanted = !!(state && state.show && state.show.indexOf('question_selected_group') >= 0);
            group.hidden = !wanted || (theme === '' && price === '');
        }
    }

    function setSynergy(isActive, multiplier) {
        var m = Number(multiplier);
        pqSynergyActive = !!isActive;
        pqSynergyMultiplier = (pqSynergyActive && isFinite(m) && m > 0) ? m : 1;
        refreshQuestionMeta();
        pqSyncSynergyRain();
    }

    // The strip now carries one fact — the player's own score — so the quiz host, who has
    // no score, never sees it at all.
    function updateScoreStrip(stateName) {
        var strip = document.getElementById('pq_score_strip');
        if (!strip) return;

        strip.hidden = !!PQ_STRIP_HIDDEN[stateName] || pqIsHost();
        if (strip.hidden) return;

        var v = document.getElementById('pq_score_value');
        if (v) v.textContent = pqMyScore;
    }
    window.setMyScore = setMyScore;

    // Who "I" am in a roster the host sends. In team mode the host scores the team, not the
    // person: the roster row, the ScoreChanged fan-out and the standings all belong to the
    // team player, whose id is the team id. Outside team mode it is this connection's id.
    function pqMyRosterId() {
        if (window.teamMode && window.myTeam && window.myTeam.TeamId) return window.myTeam.TeamId;
        return window.playerId;
    }
    window.pqMyRosterId = pqMyRosterId;

    // The roster is the host's own truth about every score including mine, so it is also the
    // repair path for the header: a ScoreChanged that was missed while this phone was away
    // (or a resume, which replays the roster and nothing else) still lands here.
    function reconcileMyScoreFrom(players) {
        var me = pqMyRosterId();
        if (!me) return;
        var mine = (players || []).find(function (p) { return p.Id === me; });
        if (mine && typeof mine.Score === 'number') setMyScore(mine.Score);
    }

    // Re-upload our custom avatar bytes when the server expects them but this page
    // never sent them. Mechanism: the game renders our texture from the blob we push
    // via CustomAvatarUploadStart/Chunk/End (commands.js) and refers to it by Hash
    // (UpdatePlayersList carries the meta: Hash/PayloadSize/Tiling/...). The blob cache
    // is per-connection: after a reload the server knows our Hash (meta survived) but
    // no longer has the bytes, so the game renders white — while the site Flat/3D
    // preview still works because the bytes survive in localStorage
    // ('custom_avatar_payload_v1', full Data included) and restore on the site.
    // The catch: after a resume-into-game we never pass SET_INFO again, so nothing
    // ever re-sends the bytes (upload only runs from SetInfo/team-create, deduped by
    // the memory-only _uploadedHash). Hence this repair, evaluated on every roster:
    // the roster shows the Hash the server expects for me; if I hold bytes for exactly
    // that Hash locally and this page hasn't uploaded them yet, push them now. A repeat
    // upload of an already-known Hash is harmless (server dedups by Hash).
    // Deliberately conservative: hash mismatch (stale/unsubmitted local bytes) and an
    // already-uploaded hash never trigger a send; failures clear only the in-flight
    // marker so the next roster retries.
    function pqReuploadCustomAvatarIfNeeded(players) {
        try {
            var me = pqMyRosterId();
            if (!me) return;
            var rows = players || [];
            var myRow = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].Id === me) { myRow = rows[i]; break; }
            }
            if (!myRow) return;
            var ca = myRow.CustomAvatar || myRow.customAvatar || null;
            var expectedHash = ca && (ca.Hash || ca.hash);
            if (!expectedHash) return;
            if (!window.customAvatar) window.customAvatar = {};
            // After reload the bytes live only in localStorage; the in-memory payload
            // is empty because the resume path never visits SET_INFO (no restore ran).
            if ((!window.customAvatar.payload || !window.customAvatar.payload.Data) &&
                typeof restoreCustomAvatarFromStorage === 'function') {
                try { restoreCustomAvatarFromStorage(); } catch (e) { /* ignore */ }
            }
            var local = window.customAvatar.payload;
            if (!local || !local.Data || !local.Hash) return;
            if (local.Hash !== expectedHash) return;
            if (window.customAvatar._uploadedHash === expectedHash) return;
            if (window.customAvatar._uploadingHash === expectedHash) return;
            if (typeof uploadCustomAvatarIfNeeded !== 'function') return;
            window.customAvatar._uploadingHash = expectedHash;
            uploadCustomAvatarIfNeeded(local).then(function () {
                // uploadCustomAvatarIfNeeded sets _uploadedHash itself on success.
                try { window.customAvatar._uploadingHash = null; } catch (e) { /* ignore */ }
            }).catch(function (err) {
                try { window.customAvatar._uploadingHash = null; } catch (e) { /* ignore */ }
                console.error('custom avatar re-upload failed', err);
            });
        } catch (e) { /* ignore */ }
    }

    // ---------- Standings (round result) and podium (game over) ----------
    // window.pqStandings is the raw SerializedPlayer[] of the last UpdatePlayersList
    // broadcast. Names come from other players, so every text node below is textContent
    // and the avatar file name is accepted only if it matches the generated allow-list.

    function pqAvatarNode(player) {
        var file = null;
        var list = window.PQ_AVATARS || [];
        if (player.Avatar) {
            if (list.indexOf(player.Avatar + '.png') !== -1) file = player.Avatar + '.png';
            else if (list.indexOf(player.Avatar) !== -1) file = player.Avatar;
        }
        if (file) {
            var img = document.createElement('img');
            img.className = 'pq-avatar pq-avatar--sm';
            img.src = '../../avatars/' + file;
            img.alt = '';
            return img;
        }
        var span = document.createElement('span');
        span.className = 'pq-avatar pq-avatar--sm';
        span.textContent = String(player.Name || '?').trim().split(/[\s.]+/).filter(Boolean)
            .map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
        return span;
    }

    function pqSortedStandings() {
        return (window.pqStandings || []).slice().sort(function (a, b) { return (b.Score || 0) - (a.Score || 0); });
    }

    function renderStandings() {
        var rows = pqSortedStandings();
        var top = rows.length ? Math.max(1, rows[0].Score || 1) : 1;
        var me = pqMyRosterId();
        var myIndex = rows.findIndex(function (p) { return p.Id === me; });

        ['pq_standings_host', 'pq_standings_player'].forEach(function (containerId) {
            var box = document.getElementById(containerId);
            if (!box) return;
            box.innerHTML = '';
            rows.forEach(function (p, i) {
                var row = document.createElement('div');
                row.className = 'pq-standing' + (p.Id === me ? ' is-me' : '');

                var bar = document.createElement('span');
                bar.className = 'pq-standing__bar';
                var pct = Math.max(6, Math.min(100, Math.round(((p.Score || 0) / top) * 100)));
                bar.style.setProperty('--w', pct + '%');
                row.appendChild(bar);

                var line = document.createElement('div');
                line.className = 'pq-standing__line';

                var rank = document.createElement('span');
                rank.className = 'pq-standing__rank';
                rank.textContent = i + 1;
                line.appendChild(rank);
                line.appendChild(pqAvatarNode(p));

                var name = document.createElement('span');
                name.className = 'pq-standing__name';
                name.textContent = p.Name || '';
                line.appendChild(name);

                var score = document.createElement('span');
                score.className = 'pq-standing__score';
                score.textContent = p.Score || 0;
                line.appendChild(score);

                row.appendChild(line);
                box.appendChild(row);
            });
        });

        var rankText = myIndex >= 0 ? '#' + (myIndex + 1) : '';
        ['pq_rank_host', 'pq_rank_player'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.textContent = rankText;
        });

        var delta = document.getElementById('pq_delta_player');
        if (delta) {
            var mine = myIndex >= 0 ? (rows[myIndex].Score || 0) : pqMyScore;
            // The baseline is frozen for as long as one round-result screen is up (HideAll
            // clears it). The screen switch and the standings broadcast are two messages and
            // either can win, so this renderer runs more than once per round; without the
            // freeze the second run would measure against the first run's own result and
            // report a delta of zero.
            if (pqDeltaBaseline === null)
                pqDeltaBaseline = (window.pqRoundStartScore == null ? mine : window.pqRoundStartScore);
            var diff = mine - pqDeltaBaseline;
            delta.textContent = diff === 0 ? '' : (diff > 0 ? '+' + diff : String(diff));
            delta.classList.toggle('is-negative', diff < 0);
            window.pqRoundStartScore = mine;
        }
    }
    window.renderStandings = renderStandings;


    // The latch is per layer, so a repeated call on the same layer never restarts a burst.
    function burstConfetti(layerId) {
        var id = layerId || 'pq_correct_confetti';
        var state = pqConfetti[id];
        var layer = document.getElementById(id);
        if (!layer || !state) return;
        if (state.done) return;
        state.done = true;
        // A cleanup timer left over from an earlier burst on this layer would wipe this one
        // mid-flight; the wipe below does its job for it.
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        layer.innerHTML = '';
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var colors = ['#8a5af7', '#1fa868', '#ef4343', '#f5c542', '#0f9bd7'];
        for (var i = 0; i < 34; i++) {
            var piece = document.createElement('span');
            piece.className = 'pq-confetti__piece';
            piece.style.setProperty('--x', Math.round(Math.random() * 92) + '%');
            piece.style.setProperty('--w2', (8 + (i % 3) * 3) + 'px');
            piece.style.setProperty('--h', (10 + (i % 4) * 3) + 'px');
            piece.style.setProperty('--c', colors[i % 5]);
            piece.style.setProperty('--d', (1.6 + Math.random() * 1.4).toFixed(2) + 's');
            piece.style.setProperty('--delay', (Math.random() * 0.9).toFixed(2) + 's');
            layer.appendChild(piece);
        }
        state.timer = setTimeout(function () { layer.innerHTML = ''; state.timer = null; }, 3600);
    }

    // ---------- "Your answer was accepted" ----------
    // Driven by ScoreChanged{ Reason, Delta } and nothing else. Reason 2 is
    // EScoreChangedReason.Question — the host awarding or docking points for an answer —
    // and a positive delta is the verdict "correct". The message is addressed
    // (SendPlayerMessageSafe to that player's own connections), so it can only ever arrive
    // on the phone of the player who answered; in team mode the addressee is the team
    // player and every member celebrates, which is the same fact.
    //
    // Deriving this from the score alone was rejected: setMyScore() is written by
    // ScoreChanged, by StartGame and by reconcileMyScoreFrom() on every UpdatePlayersList,
    // so a "score went up" test fires on a roster reconcile and on a resume replay as well
    // as on a verdict, and a wrong answer lowers the score rather than raising it.
    var PQ_CELEBRATE_DEBOUNCE_MS = 1500;
    var pqLastCelebrate = 0;

    function pqCelebrateCorrect() {
        // The quiz host has no score of their own and never celebrates.
        if (pqIsHost()) return;
        var now = Date.now();
        // One verdict, one burst: a duplicate or replayed ScoreChanged inside the window is
        // the same verdict, and the next verdict is always further away than this.
        if (now - pqLastCelebrate < PQ_CELEBRATE_DEBOUNCE_MS) return;
        pqLastCelebrate = now;
        // Re-arm this layer's one-shot latch, then fire it. burstConfetti() is the single
        // confetti implementation and it already returns early under prefers-reduced-motion.
        clearConfetti('pq_correct_confetti');
        burstConfetti('pq_correct_confetti');
    }

    function clearConfetti(layerId) {
        var state = pqConfetti[layerId];
        if (!state) return;
        state.done = false;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        var layer = document.getElementById(layerId);
        if (layer) layer.innerHTML = '';
    }

    // ---------- Synergy rain ----------
    // Synergy is a state, not an event, so its confetti falls for as long as the state
    // lasts instead of bursting once. Three things keep that from becoming a leak on a
    // phone: exactly one spawn interval ever exists, the live piece count is capped, and
    // every piece removes itself when its own animation ends.

    var PQ_RAIN_LAYER = 'pq_synergy_confetti';
    var PQ_RAIN_MAX_PIECES = 54;   // hard ceiling on live nodes, whatever the tick does
    var PQ_RAIN_TICK_MS = 600;
    var PQ_RAIN_BATCH = 5;         // per tick
    var PQ_RAIN_OPENING = 16;      // the first tick reads as a burst
    var PQ_RAIN_SWEEP_MS = 4200;   // > longest possible piece lifetime
    var PQ_CONFETTI_COLORS = ['#8a5af7', '#1fa868', '#ef4343', '#f5c542', '#0f9bd7'];
    var pqRainInterval = null;
    var pqRainSweep = null;

    function pqReducedMotion() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) { return false; }
    }

    function pqRainTick(count) {
        var layer = document.getElementById(PQ_RAIN_LAYER);
        if (!layer) { pqStopSynergyRain(); return; }

        // A backgrounded tab freezes the animations, so animationend never arrives and the
        // pieces pile up. Trimming from the front bounds the layer regardless.
        while (layer.childElementCount > PQ_RAIN_MAX_PIECES) layer.removeChild(layer.firstChild);
        var n = Math.min(count, PQ_RAIN_MAX_PIECES - layer.childElementCount);

        for (var i = 0; i < n; i++) {
            var piece = document.createElement('span');
            piece.className = 'pq-confetti__piece';
            piece.style.setProperty('--x', Math.round(Math.random() * 96) + '%');
            piece.style.setProperty('--w2', (7 + Math.floor(Math.random() * 4) * 2) + 'px');
            piece.style.setProperty('--h', (9 + Math.floor(Math.random() * 4) * 3) + 'px');
            piece.style.setProperty('--c', PQ_CONFETTI_COLORS[Math.floor(Math.random() * PQ_CONFETTI_COLORS.length)]);
            piece.style.setProperty('--d', (2.2 + Math.random() * 1.2).toFixed(2) + 's');
            piece.style.setProperty('--delay', '0s');
            piece.addEventListener('animationend', pqRainPieceDone);
            layer.appendChild(piece);
        }
    }

    function pqRainPieceDone(e) {
        var piece = e.currentTarget;
        piece.removeEventListener('animationend', pqRainPieceDone);
        if (piece.parentNode) piece.parentNode.removeChild(piece);
    }

    function pqStartSynergyRain() {
        var layer = document.getElementById(PQ_RAIN_LAYER);
        if (!layer) return;
        if (pqRainSweep) { clearTimeout(pqRainSweep); pqRainSweep = null; }
        // Same contract as every other animation in this client.
        if (pqReducedMotion()) return;
        if (pqRainInterval) return;                       // already raining
        pqRainTick(PQ_RAIN_OPENING);
        pqRainInterval = setInterval(function () { pqRainTick(PQ_RAIN_BATCH); }, PQ_RAIN_TICK_MS);
    }

    function pqStopSynergyRain() {
        if (pqRainInterval) { clearInterval(pqRainInterval); pqRainInterval = null; }

        var layer = document.getElementById(PQ_RAIN_LAYER);
        if (pqRainSweep) { clearTimeout(pqRainSweep); pqRainSweep = null; }
        if (!layer || !layer.firstChild) return;          // nothing in the air, nothing to sweep

        // Pieces still falling keep their own animationend and disappear on their own, so
        // synergy ending does not blink them out of the sky. The sweep is the backstop for
        // the case where that event never comes (backgrounded tab).
        pqRainSweep = setTimeout(function () {
            pqRainSweep = null;
            var l = document.getElementById(PQ_RAIN_LAYER);
            if (l) l.innerHTML = '';
        }, PQ_RAIN_SWEEP_MS);
    }

    // The single entry point: the rain is on exactly when synergy is. Called from
    // setSynergy() and from HideAll(), so no screen change can leave an interval behind.
    function pqSyncSynergyRain() {
        if (pqSynergyActive) pqStartSynergyRain();
        else pqStopSynergyRain();
    }

    var PQ_THEMES = ['studio', 'night'];

    function pqStoredTheme() {
        try {
            var v = localStorage.getItem('pq_theme');
            return PQ_THEMES.indexOf(v) !== -1 ? v : null;
        } catch (e) { return null; }
    }

    function pqSystemTheme() {
        try {
            return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'night' : 'studio';
        } catch (e) { return 'studio'; }
    }

    function pqApplyTheme(value) {
        if (PQ_THEMES.indexOf(value) === -1) {
            document.documentElement.removeAttribute('data-pq-theme');
            return;
        }
        document.documentElement.setAttribute('data-pq-theme', value);
    }

    function pqCurrentTheme() { return pqStoredTheme() || pqSystemTheme(); }

    function updateThemeToggle(stateName) {
        var btn = document.getElementById('pq_theme_toggle');
        if (!btn) return;
        btn.hidden = stateName !== 'ENTER_ID';
        btn.textContent = pqCurrentTheme() === 'night' ? '☀' : '☾';
    }

    function ToggleTheme() {
        var next = pqCurrentTheme() === 'night' ? 'studio' : 'night';
        try { localStorage.setItem('pq_theme', next); } catch (e) { /* private mode */ }
        pqApplyTheme(next);
        updateThemeToggle(currentState);
    }
    window.ToggleTheme = ToggleTheme;

    // Bot telemetry: page transitions + received commands land in the Unity console
    // via the farm's local static server (/pqlog). Bots only, fire-and-forget.
    function botReport(text) {
        if (!window.pqBot) return;
        try {
            fetch('/pqlog?bot=' + encodeURIComponent(getQueryParam('name') || '?')
                + '&m=' + encodeURIComponent(text));
        } catch (e) { /* ignore */ }
    }

    var botRoleSent = false;
    var botInfoSent = false;
    var botHostReady = false;   // host has sent LoadRoleSelectionPage — safe to send SetRole
    var botMemberNameSet = false;
    var botTeamSent = false;
    var botTeamsSynced = false; // first TeamListUpdated received — safe to decide join vs create
    var botResumeSent = false;

    function botRandomAvatar() {
        if (typeof avatars === 'undefined' || avatars.length === 0) return '';
        var idx = Math.floor(Math.random() * avatars.length);
        if (typeof CUSTOM_AVATAR_ID !== 'undefined' && avatars[idx] === CUSTOM_AVATAR_ID) idx = 0;
        return avatars[idx];
    }

    // In team mode: join the team named in ?team= once it exists; the bot flagged
    // ?teamcreate=1 creates it. Called on TEAM_LOBBY entry and on TeamListUpdated.
    function botTryJoinTeam() {
        if (!window.pqBot || botTeamSent || window.myTeam) return;
        if (getQueryParam('role') === 'host') return;
        if (currentState !== 'TEAM_LOBBY') return;
        // Never decide before the roster arrives — creating against an empty
        // not-yet-synced list would duplicate the team after a page refresh
        if (!botTeamsSynced) return;
        var teamName = getQueryParam('team');
        if (!teamName || !window.myMemberName) return;

        var team = (window.teams || []).find(function (t) { return t.Name === teamName; });

        if (team) {
            botTeamSent = true;
            JoinTeam(team.TeamId, window.myMemberName);
        } else if (getQueryParam('teamcreate') === '1') {
            botTeamSent = true;
            CreateTeam(teamName, botRandomAvatar());
        }
    }

    function maybeBotAutoAdvance(stateName) {
        if (!window.pqBot) return;

        // Wait for the host's LoadRoleSelectionPage: sending SetRole right after
        // ClientStateChanged races the matchmaker's join ("Player not found").
        if (stateName === 'ROLE_SELECTION' && !botRoleSent && botHostReady) {
            botRoleSent = true;
            if (getQueryParam('role') === 'host') SetHostRole();
            else SetPlayerRole();
            return;
        }

        if (stateName === 'RESUME_GAME' && !botResumeSent) {
            botResumeSent = true;
            ResumeGame();
            return;
        }

        // A host bot must never act as a team member (in team mode the Unity host
        // routes any connection's SetRole to the team lobby — there is no browser host).
        if (getQueryParam('role') === 'host'
            && (stateName === 'ENTER_MEMBER_NAME' || stateName === 'TEAM_LOBBY')) {
            return;
        }

        if (stateName === 'ENTER_MEMBER_NAME' && !botMemberNameSet) {
            var memberName = getQueryParam('name');
            if (!memberName) return;
            botMemberNameSet = true;
            window.myMemberName = memberName;
            goTo('TEAM_LOBBY');
            return;
        }

        if (stateName === 'TEAM_LOBBY') {
            botTryJoinTeam();
            return;
        }

        if (stateName === 'SET_INFO' && !botInfoSent) {
            if (window.teamMode && getQueryParam('role') !== 'host') return;
            var botName = getQueryParam('name');
            if (!botName) return;
            botInfoSent = true;

            document.getElementById('player_name').value = botName;

            if (avatars.length > 0) {
                var idx = Math.floor(Math.random() * avatars.length);
                if (typeof CUSTOM_AVATAR_ID !== 'undefined' && avatars[idx] === CUSTOM_AVATAR_ID) idx = 0;
                currentAvatarIndex = idx;
                updateCarousel(false);
            }

            SetInfo();
        }
    }

    function goTo(stateName, data) {
        var state = PAGE_STATES[stateName];
        if (!state) { console.error('Unknown page state:', stateName); return; }

        HideAll();

        if (state.title != null)
            document.getElementById('title').textContent =
                typeof state.title === 'function' ? state.title(data) : state.title;

        if (state.undertitle != null)
            document.getElementById('undertitle').textContent =
                typeof state.undertitle === 'function' ? state.undertitle(data) : state.undertitle;

        if (state.show)
            for (var i = 0; i < state.show.length; i++) {
                var el = document.getElementById(state.show[i]);
                if (el) {
                    el.hidden = false;
                    el.classList.remove('screen-enter');
                    void el.offsetWidth;
                    el.classList.add('screen-enter');
                }
            }

        if (state.onEnter) state.onEnter(data);

        // Runs after onEnter, because several states write #title from there. A state that
        // owns its headline inside its own card leaves both spans empty, and the strip then
        // contributed nothing but the gap above that card.
        var topic = document.querySelector('.topic-block');
        if (topic) topic.hidden = !document.getElementById('title').textContent
            && !document.getElementById('undertitle').textContent;

        var prev = currentState;
        currentState = stateName;
        // PQRevamped: remember last state data so pq:languageChanged can re-render titles.
        // NOTE: both are mirrored to window — the pq:languageChanged listener runs on
        // document and reads window.currentState (the closure-local currentState is not
        // visible there by name). Previously only currentStateData was mirrored, so
        // window.currentState stayed undefined and title/undertitle never re-rendered
        // until the next goTo() (i.e. reload / round change).
        try { window.currentState = stateName; window.currentStateData = data; } catch (e) { /* ignore */ }

        // After show:[] revealed the panel and after onEnter had its chance to set the meta:
        // repaints both labels for the current question and hides the panel if there is none.
        // Runs once currentState is the new one, because that is what it tests against.
        refreshQuestionMeta();

        document.body.dataset.pqScreen = PQ_SCREEN_FAMILY[stateName] || 'onboard';
        // The family alone cannot tell a confirmation from a wait when the state owns no
        // group to test with :has() — SEQUENCE_PLAYER is the case that bit us. Written on
        // every transition from the one place that knows the state, so it can never go
        // stale. Read by pq-screens.css; nothing branches on it in JS.
        document.body.dataset.pqState = stateName;
        console.log('Page: ' + (prev || '(init)') + ' → ' + stateName);
        botReport('Page: ' + (prev || '(init)') + ' -> ' + stateName);

        // Проба плашки: один отчёт на каждый вход в панель, которой мета положена.
        // Читает то же, что видит игрок — сами метки, уже перерисованные выше.
        if (PQ_META_PLAQUE_STATES[stateName]) {
            var mp = document.getElementById('question_selected_price');
            var mt = document.getElementById('question_selected_theme');
            botReport('METAPLAQUE state=' + stateName
                + ' price="' + (mp ? String(mp.textContent || '').trim() : '')
                + '" theme="' + (mt ? String(mt.textContent || '').trim() : '')
                + '" src=' + (pqMetaSource || 'none'));
        }

        updateCaptainBadge();
        updateScoreStrip(stateName);
        updateThemeToggle(stateName);

        // PQRevamped: refresh re-requests the current game from the server, so it is
        // only meaningful while in a game. Drive it from every Page transition (this
        // is the one place that knows the state) — e.g. game over lands on ENTER_ID
        // and the button must go away with the game, not stay clickable.
        pqSyncRefreshButton(!PQ_REFRESH_HIDDEN_STATES[stateName]);

        // PQRevamped: re-evaluate the emoji layer for the INCOMING screen. HideAll()
        // runs at the top of goTo() while currentState still names the OUTGOING screen,
        // so its ShowEmojiGroup() call answers for the wrong screen — e.g. APPLAUSE →
        // ENTER_ID left the layer visible (flex from APPLAUSE) with a live toggle, and
        // the next tap sent PlayEmoji into a dead game ("Game not found"). currentState
        // is already the new one here, so this call decides correctly.
        ShowEmojiGroup();

        maybeBotAutoAdvance(stateName);
    }

    window.goTo = goTo;
    // PQRevamped: expose PAGE_STATES for the pq:languageChanged listener so it can
    // re-render title/undertitle without re-running onEnter (which would re-fire
    // mid-round side-effects). The listener only reads title/undertitle functions.
    try { window._pqPageStates = PAGE_STATES; } catch (e) { /* ignore */ }

    // PQRevamped: when the user switches language mid-game, re-run goTo with the last
    // (stateName, data) so the title/undertitle are re-translated. Several screens also
    // bind their own texts in onEnter (applause, picking, theme lists) and would otherwise
    // stay in the previous language until the next round.
    try {
        document.addEventListener('pq:languageChanged', function (ev) {
            try {
                // Sync the in-game <select> with the new language.
                var sel = document.getElementById('lang_switcher');
                if (sel && ev && ev.detail && ev.detail.lang) {
                    sel.value = ev.detail.lang;
                }
                // PQRevamped: re-translate title/undertitle without re-running onEnter,
                // which would re-fire side-effects mid-round (theme re-renders, applause
                // text etc.). This is what goTo() does internally for title/undertitle;
                // we just skip the HideAll/show[]/onEnter steps.
                try {
                    // currentState is closure-local; window.currentState is its mirror set in goTo().
                    var s = window.currentState || currentState;
                    if (s && window._pqPageStates && window._pqPageStates[s]) {
                        var state = window._pqPageStates[s];
                        if (state.title != null) {
                            var el = document.getElementById('title');
                            if (el) {
                                el.textContent = typeof state.title === 'function'
                                    ? state.title(window.currentStateData) : state.title;
                            }
                        }
                        if (state.undertitle != null) {
                            var el2 = document.getElementById('undertitle');
                            if (el2) {
                                el2.textContent = typeof state.undertitle === 'function'
                                    ? state.undertitle(window.currentStateData) : state.undertitle;
                            }
                        }
                        // Mirror goTo()'s topic-block visibility logic.
                        var topic = document.querySelector('.topic-block');
                        if (topic) {
                            var tEl = document.getElementById('title');
                            var uEl = document.getElementById('undertitle');
                            topic.hidden = !(tEl && tEl.textContent) && !(uEl && uEl.textContent);
                        }
                    }
                } catch (e) { /* ignore — best-effort title re-render */ }
            } catch (e) { console.error('[pq:languageChanged]', e); }
        });
    } catch (e) { /* ignore */ }

    // PQRevamped: when i18n is ready, prime the in-game <select>.
    try {
        if (window.i18n && window.i18n.ready && typeof window.i18n.ready.then === 'function') {
            window.i18n.ready.then(function () {
                try {
                    var sel2 = document.getElementById('lang_switcher');
                    if (sel2 && window.i18n && window.i18n.lang) sel2.value = window.i18n.lang;
                } catch (e) { /* ignore */ }
            });
        }
    } catch (e) { /* ignore */ }

    function showOverlay(sectionId) {
        var el = document.getElementById(sectionId);
        if (el) el.hidden = false;
    }

    // Expose for debugging
    window._gameState = { get current() { return currentState; }, PAGE_STATES: PAGE_STATES };

    SendMessage = message => {
        let result = JSON.stringify({'Message': JSON.stringify(message)});
        console.log("out: " + result);
        if (socket && socket.readyState === WebSocket.OPEN)
            socket.send(result);
        else
            console.error('WebSocket not connected');
    };

    function createSocket() {
        if (socket) {
            // A replaced socket keeps its own onclose and drives its own setTimeout(createSocket)
            // chain; two chains race and the matchmaker kills the older one on duplicate login.
            try {
                socket.onopen = null;
                socket.onmessage = null;
                socket.onclose = null;
                socket.close();
            } catch (e) { /* ignore */ }
        }

        connecting = true;

        let serverOverride = getQueryParam('server');
        let host = serverOverride || window.location.hostname;

        // Static fork: this page is usually NOT served by the game server itself
        // (GitHub Pages, localhost/LAN preview, file://), so a foreign hostname must
        // never be used for the game socket — e.g. on Pages this built
        // wss://muxira.github.io:3012, which refuses the connection and leaves the
        // client blinking orange in "loading" forever. Default to the live
        // infrastructure; ?server= still overrides (local/dev servers, stage).
        // This matches the README ("defaults to partyquiz.club from any domain").
        if (!serverOverride && host !== 'partyquiz.club' && host !== 'stage.partyquiz.club')
            host = "partyquiz.club";

        let port = 3012;

        if (host == "stage.partyquiz.club")
            port = 5012;

        setConnectionDotState('reconnecting');

        // Cross-origin pages (local client farm) can't send the id cookie with the
        // handshake — pass the session id in the URL so the matchmaker can log us in.
        var sessionSuffix = '';
        if (window.pqBot) {
            try {
                var savedState = JSON.parse(window.pqStore.getItem('state') || 'null');
                if (savedState && savedState.id) sessionSuffix = '/?id=' + encodeURIComponent(savedState.id);
            } catch (e) { /* ignore */ }
        }

        socket = new WebSocket(`wss://${host}:${port}` + sessionSuffix);

        socket.onopen = onSocketOpen;
        socket.onmessage = onSocketMessage;
        socket.onclose = onSocketClose;
        updateConnectionScreen();
    }

    function getQueryParam(name) {
        try {
            return new URL(window.location.href).searchParams.get(name);
        } catch (e) {
            return null;
        }
    }

    function clearGameQueryParam() {
        try {
            var url = new URL(window.location.href);
            if (!url.searchParams.has('game')) return;
            url.searchParams.delete('game');
            window.history.replaceState({}, '', url.toString());
        } catch (e) {
            // ignore
        }
    }

    function onSocketOpen() {
        // PQRevamped: the socket is open, so we are not "connecting" anymore — say so FIRST,
        // explicitly, before anything else in this handler. updateConnectionScreen() renders
        // `screen.hidden = !(inGame && connecting)`, so every path below must observe the
        // settled value, not depend on where in this function the assignment happens to sit.
        // (createSocket() sets connecting=true; onSocketClose() sets it false on drop.)
        connecting = false;

        // CONN-03: Clear stale state from previous session before re-registering
        resetGameState();

        // PQRevamped: one-shot auto-send latch contracts (single source of truth per send).
        // - window._pqAutoResumeSent: ResumeGame, lifetime = ONE WS connection ("exactly once
        //   per WS connection"). Re-armed here because a new socket needs its own resume
        //   decision. Whether ResumeGame is actually re-sent is still decided below by
        //   (wasInGame, startedNewGame, inGame): a reconnect into a live screen takes the
        //   keep-screen early return and never double-sends; a fresh load into a running
        //   game re-sends exactly as before. Net effect today: provably a no-op on every
        //   traceable path — it only closes the latch for future edits to misuse.
        // - autoJoinSent (below + ClientStateChanged): QR Join, lifetime = PAGE. Deliberately
        //   NOT reset here: the server may already have processed the join on the dead socket,
        //   and a duplicate Join kills the just-established session ("Player not found" is
        //   terminal — see the note on qrJoinGameId above).
        // - startedNewGame: set by TryJoinGame/TryJoinGameWithId, cleared by onGameEnded.
        try { window._pqAutoResumeSent = false; } catch (e) { /* ignore */ }

        // CONN-07: Clear disconnect toast and countdown
        if (disconnectCountdownIntervalId) {
            clearInterval(disconnectCountdownIntervalId);
            disconnectCountdownIntervalId = null;
        }
        var reconnectionScreen = document.getElementById('reconnection_screen');
        if (reconnectionScreen) reconnectionScreen.hidden = true;

        // PQRevamped: do NOT show the refresh button here. On socket open we don't know
        // yet whether there is a game — visibility is driven by goTo() (per PAGE_STATE)
        // and by ClientStateChanged (server truth). Showing it unconditionally left it
        // clickable on ENTER_ID, where RefreshData provoked "Game not found".
        // (connecting was already settled to false at the top of this handler.)

        reconnectExhausted = false;
        hideReconnectTerminal();

        if (reconnectStableTimerId) clearTimeout(reconnectStableTimerId);

        // Only a connection that survived RECONNECT_STABLE_MS counts as recovery. Zeroing on open
        // lets an open→close ping-pong reset the counter forever, which is why the ceiling never fired.
        reconnectStableTimerId = setTimeout(function () {
            reconnectAttempt = 0;
            reconnectStableTimerId = null;
        }, RECONNECT_STABLE_MS);

        setConnectionDotState('connected');
        updateConnectionScreen();

        // Always capture ?game= from URL so we can use it after the server responds.
        var gameFromUrl = getQueryParam('game');
        if (gameFromUrl) {
            qrJoinGameId = gameFromUrl.toUpperCase();
            document.getElementById('game_id').value = qrJoinGameId;
        }

        let state = null;
        try {
            state = JSON.parse(window.pqStore.getItem('state') || 'null');
        } catch (e) {
            console.error('Failed to parse saved state', e);
        }

        if (state == null || state.id == null) {
            if (qrJoinGameId && !autoJoinSent) {
                // Latch AFTER the send: if socket.send throws, the handler must not be left
                // half-run with the join marked done (that would skip both the retry via a
                // later ClientStateChanged and the ENTER_ID fallback below).
                TryJoinGameWithId(qrJoinGameId, '');
                autoJoinSent = true;
                console.log("QR join: auto-joining game " + qrJoinGameId);
            } else if (qrJoinGameId) {
                console.log("QR join: already sent, skipping duplicate");
            } else {
                console.log("Register new player");
                goTo('ENTER_ID');
            }
        } else {
            // Existing session — wait for server's ClientStateChanged to determine
            // whether we're still in a game or free to QR-join a new one.
            console.log("Login: " + state.id);
        }

        console.log("Current state is " + window.pqStore.getItem('state'));
    }

    function onSocketMessage(event) {
        console.log("in: " + event.data);

        let response = JSON.parse(event.data);

        let role = window.pqStore.getItem('role');
        let isHost = role == 'host';
        // Team members never receive SetRoleResult (the host routes their SetRole to the
        // team lobby), so stored role stays empty — in team mode they are players by definition.
        let isPlayer = role == 'player' || (window.teamMode === true && !isHost);

        if (response.MatchMakerError) {
            var isWrongPassword = response.MatchMakerError.text === 'Wrong password';

            if (isWrongPassword && qrJoinGameId) {
                var isRetry = qrJoinAwaitingPassword;
                qrJoinAwaitingPassword = true;
                showQrPasswordPrompt(qrJoinGameId);
                if (isRetry) {
                    var errEl = document.getElementById('qr_password_error');
                    if (errEl) errEl.textContent = t('mm_wrong_password');
                }
            } else {
                var mmErrorText = response.MatchMakerError.text;
                var mmKey = 'mm_' + mmErrorText.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                var localized = t(mmKey);
                var mmMessage = localized !== mmKey ? localized : mmErrorText;

                var isSessionLost = mmErrorText == 'Player not found';

                // "Session is gone" is terminal, not transient: there is no re-registration on a live
                // socket, so the only way out of a dead session is an explicit exit.
                if (isSessionLost) {
                    reportError(mmMessage);
                    onGameEnded('session-lost');
                    return;
                }

                // Everything else that arrives in-game is transient by construction: the host may be
                // inside its grace window and the game is expected to survive. Bouncing the player to
                // ENTER_ID here throws away a live session over a temporary condition.
                if (inGame) {
                    reportError(mmMessage);
                } else {
                    qrJoinGameId = null;
                    qrJoinAwaitingPassword = false;
                    autoJoinSent = false;
                    goTo('ENTER_ID');
                    reportError(mmMessage);
                }
            }
        } else {
            clearInlineError('error_label');
        }

        if (response == 'BadRequest' || (response.MatchMakerError && response.MatchMakerError.text == 'Player with id not found')) {
            // register new player
        } else {
            if (response.SetCookie) {
                document.cookie = "id=" + response.SetCookie;
            } else if (response.ClientStateChanged) {
                let playerId = response.ClientStateChanged.player_id;
                window.playerId = playerId;

                console.log("Saving player id " + playerId);

                let gameId = response.ClientStateChanged.game_id;
                let wasInGame = inGame;
                inGame = gameId != null;

                // PQRevamped: mirror server truth for the refresh guards (handleRefresh
                // in this file, RefreshData in commands.js) and the refresh button.
                // The button needs BOTH signals: a live game_id AND a screen where
                // refresh makes sense — a joined player sitting on ROLE_SELECTION /
                // SET_INFO must not get it re-shown by a bare ClientStateChanged.
                // Capture the previous id BEFORE overwriting: entering a game with a
                // new id (fresh join, or a new game on the same page) must drop the
                // stale client score — see the reset below.
                var prevGameId = null;
                try { prevGameId = window.pqGameId; } catch (e) { prevGameId = null; }
                try { window.pqGameId = (gameId != null) ? gameId : null; } catch (e) { /* ignore */ }
                pqSyncRefreshButton(gameId != null && !!currentState && !PQ_REFRESH_HIDDEN_STATES[currentState]);

                // PQRevamped: entering a game we weren't in (new id, incl. a new game on
                // the same page) — reset the client score to 0 right here. It is a
                // temporary value: the next UpdatePlayersList repairs it via
                // reconcileMyScoreFrom(). No race: WS messages are processed strictly in
                // arrival order and the server sends ClientStateChanged on connect before
                // any roster broadcast, so a roster carrying the true score always lands
                // AFTER this reset and overwrites it. Echoes of the same game_id
                // (gameId === prevGameId) skip the reset so mid-game repeats can't flash 0.
                // Round/delta baselines go with it — otherwise the first standings of the
                // new game would measure a phantom delta against the old game's score.
                if (inGame && gameId !== prevGameId) {
                    setMyScore(0);
                    try { window.pqRoundStartScore = 0; } catch (e) { /* ignore */ }
                    pqDeltaBaseline = null;
                }

                if (inGame) {
                    qrJoinGameId = null;
                    qrJoinAwaitingPassword = false;
                    hideQrPasswordPrompt();
                    clearGameQueryParam();

                    if (wasInGame) {
                        // keep the previous screen
                        return;
                    } else if (startedNewGame) {
                        window.pqStore.setItem('state', JSON.stringify({'id': playerId}));
                        goTo('ROLE_SELECTION');
                    } else {
                        // PQRevamped: auto-resume ONCE on reload-into-running-game. The server
                        // would otherwise stick us on the unreachable-server screen with just a
                        // Leave button. We send ResumeGame exactly once per WS connection.
                        goTo('RESUME_GAME');
                        if (!window._pqAutoResumeSent) {
                            window._pqAutoResumeSent = true;
                            try { setTimeout(function () { if (typeof ResumeGame === 'function') ResumeGame(); }, 200); } catch (e) { /* ignore */ }
                        }
                    }
                } else {
                    if (wasInGame) {
                        onGameEnded('client-state-changed');
                        return;
                    }

                    if (qrJoinGameId && !autoJoinSent) {
                        autoJoinSent = true;
                        console.log("QR join: session clear, auto-joining game " + qrJoinGameId);
                        TryJoinGameWithId(qrJoinGameId, '');
                    } else if (qrJoinGameId) {
                        console.log("QR join: already sent, skipping duplicate");
                    } else {
                        goTo('ENTER_ID');
                    }
                }
            } else if (response.Message) {
                let messageData = JSON.parse(response.Message);

                if (messageData.PlayerMessage == null)
                    return;

                let message = JSON.parse(messageData.PlayerMessage.text);

                if (message != null) {
                    if (message.HostLeftGame) {
                        onGameEnded('host-left');
                        return;
                    }

                    console.info("have new message " + message.Command);
                    let command = message.Command;

                    if (command) botReport('cmd: ' + command);

                    if (command == "Error") {
                        console.error(message.Message);
                        reportError(message.Message);
                    } else if (command == "LoadRoleSelectionPage") {
                        botHostReady = true;
                        goTo('ROLE_SELECTION');
                    } else if (command == "LoadTeamLobby") {
                        // Connections get no SetRoleResult, so route as the SetRoleResult team branch does.
                        window.teamMode = true;
                        recomputeMyTeam();
                        goTo(window.myTeam ? 'TEAM_LOBBY' : 'ENTER_MEMBER_NAME');
                    } else if (command == "LoadSetInfoPage") {
                        // Host can disable custom avatars for the session.
                        // Default to true for backward compatibility with older hosts.
                        try {
                            window.allowCustomAvatars = (message.AllowCustomAvatars !== false);
                        } catch (e) {
                            window.allowCustomAvatars = true;
                        }
                        // Team mode: no per-player Set-Info — the team owns the avatar. Ignore
                        // (the host shouldn't send this in team mode, but guard defensively).
                        if (!window.teamMode)
                            goTo('SET_INFO');
                    } else if (command == "SetRoleResult") {
                        if (message.SetRoleResult.IsRoleSet) {
                            window.pqStore.setItem('role', message.SetRoleResult.Role);
                            // Host can disable custom avatars for the session.
                            // Default to true for backward compatibility with older hosts.
                            try {
                                const v = message.SetRoleResult.AllowCustomAvatars;
                                window.allowCustomAvatars = (v !== false);
                            } catch (e) {
                                window.allowCustomAvatars = true;
                            }
                            window.teamMode = (message.SetRoleResult.TeamMode === true);
                            if (window.teamMode && message.SetRoleResult.Role === 'player') {
                                goTo(window.myTeam ? 'TEAM_LOBBY' : 'ENTER_MEMBER_NAME');
                            } else {
                                goTo('SET_INFO');
                            }
                        } else {
                            clearInlineError('role_set_error');
                            reportError(message.SetRoleResult.Error);
                        }
                    } else if (command == "TeamListUpdated") {
                        window.teams = (message.TeamListUpdated && message.TeamListUpdated.Teams) || [];
                        window.teamGameInProgress = !!(message.TeamListUpdated && message.TeamListUpdated.GameInProgress);
                        botTeamsSynced = true;
                        recomputeMyTeam();
                        // Team members do NOT do Set-Info: the avatar belongs to the team and the
                        // member's name is the team member name. Just land on / refresh the team view.
                        if (window.teamMode && window.myTeam
                            && (currentState === 'TEAM_CREATE' || currentState === 'ENTER_MEMBER_NAME')) {
                            goTo('TEAM_LOBBY');
                        } else if (currentState === 'TEAM_LOBBY') {
                            renderTeamList();
                            botTryJoinTeam();
                        }
                    } else if (command == "TeamMemberPressed") {
                        var actor = message.TeamMemberPressed && message.TeamMemberPressed.ActorName;
                        showTeamToast(actor);
                        if (actor) window.teamPressed[actor] = true;
                        if (SUGG_STATES.indexOf(currentState) !== -1) renderSuggestions();
                    } else if (command == "TeamSuggestionsUpdated") {
                        window.teamSuggestions = (message.TeamSuggestionsUpdated && message.TeamSuggestionsUpdated.Items) || [];
                        // Only refresh the strip if we're on a screen that shows it — otherwise it would
                        // re-appear and linger on unrelated screens after HideAll already hid it.
                        if (SUGG_STATES.indexOf(currentState) !== -1) renderSuggestions();
                    } else if (command == "InfoSetResult") {
                        window.pqStore.setItem('name', message.InfoSetResult.Name);

                        document.getElementById('player_name').value = message.InfoSetResult.Name;
                        document.getElementById('all_here_player_name').textContent = message.InfoSetResult.Name;
                        document.getElementById('select_question_player_group_name').textContent = message.InfoSetResult.Name;

                        if (message.InfoSetResult.IsInfoSet == false) {
                            clearInlineError('info_set_error');
                            reportError(message.InfoSetResult.Error);
                        } else {
                            clearInlineError('info_set_error');
                            // Show success toast
                            if (typeof showToast === 'function') showToast();
                        }
                        // Update button state after response
                        if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
                    } else if (command == "UpdateConnectedPlayers") {
                        if (isHost)
                            DisplayConnectedPlayersListHostPage(message.UpdateConnectedPlayers);
                    } else if (command == "GetReady") {
                        if (isPlayer) {
                            goTo('GET_READY');
                        }
                    } else if (command == "CanAnswer") {
                        // Check sequence number to avoid processing stale messages
                        const canAnswerSeq = message.CanAnswer ? message.CanAnswer.SequenceNumber : undefined;

                        // A newer answering window beats the latch; only a same-or-older CanAnswer
                        // is suppressed while somebody is still answering.
                        if (isInAnsweringState && !(typeof canAnswerSeq === 'number' && canAnswerSeq > answeringSeq))
                            return;

                        if (!shouldProcessCanAnswerMessage(canAnswerSeq)) {
                            return;
                        }

                        if (isHost) {
                            goTo('QUESTION_SELECTED');
                            showOverlay('dismiss_question_group');
                        } else if (isPlayer) {
                            resetTeamSuggestions();
                            var ca = message.CanAnswer || {};
                            var caCant = ca.TriedToAnswer || ca.WasCorrect;
                            if (teamScreenFor('CAN_ANSWER', 'TEAMMATE_SUGGEST') === 'TEAMMATE_SUGGEST') {
                                if (caCant)
                                    goTo('TEAMMATE_READONLY', { cantAnswer: true });
                                else
                                    goTo('TEAMMATE_SUGGEST', { showBuzzer: true, label: 'your_suggestion' });
                            } else {
                                goTo('CAN_ANSWER', { triedToAnswer: ca.TriedToAnswer, wasCorrect: ca.WasCorrect });
                            }
                        }
                    } else if (command == "QuestionHasAudio") {
                        if (isHost)
                            showOverlay('replay_question_audio_group');
                    } else if (command == "ContinueGame") {
                        // Continuing a game clears the answering latch and sequence tracker
                        resetAnsweringTracking();
                        // The board is back for everyone, including the team-mate who lands on
                        // TEAMMATE_READONLY and never passes through a SELECT_QUESTION_* state.
                        clearQuestionContext();

                        pqSelectorName = message.ContinueGame.Selector || pqSelectorName;

                        if (message.ContinueGame.AllowedToChoose) {
                            if (window.teamMode && !window.amCaptain && !isHost)
                                goTo('TEAMMATE_READONLY'); // only the captain (or the quiz host) picks the question
                            else
                                goTo('SELECT_QUESTION_HOST', { themes: message.ContinueGame.Themes });
                        } else {
                            goTo('SELECT_QUESTION_PLAYER', { selector: message.ContinueGame.Selector });
                        }
                    } else if (command == "QuestionSelected") {
                        // During Answering state resume, Unity sends both
                        // QuestionSelected and PlayerStartedAnswering.
                        // If we're already on the answering screen, only
                        // update host-side data without navigating away.
                        if (currentState === 'PLAYER_ANSWERS_HOST' || currentState === 'YOU_ANSWER') {
                            if (isHost) {
                                document.getElementById('right_answer').textContent = message.QuestionSelected.Answer;
                            }
                        } else {
                            goTo('QUESTION_SELECTED', message.QuestionSelected);

                            if (isHost) {
                                showOverlay('skip_displaying_group');
                                document.getElementById('right_answer').textContent = message.QuestionSelected.Answer;
                            }
                        }
                    } else if (command == "ScoreChanged") {
                        // Score is this player's own running total; a message without one is
                        // never a reason to show a zero.
                        var scoreChanged = message.ScoreChanged || {};
                        if (scoreChanged.Score != null) {
                            document.getElementById('select_question_player_group_score').textContent = scoreChanged.Score;
                            setMyScore(scoreChanged.Score);
                        }
                        // Reason 2 = EScoreChangedReason.Question; Delta is this change alone
                        // (Current - Last at the moment the host raised the event), so the
                        // test is "the host judged my answer, and judged it right".
                        if (scoreChanged.Reason === 2 && typeof scoreChanged.Delta === 'number' && scoreChanged.Delta > 0)
                            pqCelebrateCorrect();
                    } else if (command == "QuestionMeta") {
                        // Data only. The three question types that open with a narrative sequence
                        // never send QuestionSelected, because that command navigates; this one
                        // fills the theme and the price panel and moves nobody.
                        var meta = message.QuestionMeta || {};
                        setQuestionMeta(meta.Theme, meta.Price);
                    } else if (command == "SynergyChanged") {
                        var syn = message.SynergyChanged || {};
                        // setSynergy() owns the rain: it starts on the first active message
                        // and a repeat is a no-op, it stops on the first inactive one.
                        setSynergy(syn.IsActive, syn.Multiplier);
                    } else if (command == "StartGame") {
                        // A new game clears the answering latch and sequence tracker
                        resetAnsweringTracking();
                        clearQuestionContext();

                        pqSelectorName = message.StartGame.Selector || pqSelectorName;

                        if (message.StartGame.AllowedToChoose) {
                            if (window.teamMode && !window.amCaptain && !isHost)
                                goTo('TEAMMATE_READONLY'); // only the captain (or the quiz host) picks the question
                            else
                                goTo('SELECT_QUESTION_HOST', { themes: message.StartGame.Themes });
                        } else {
                            // StartGame carries the selector and the themes and nothing else:
                            // the host's OngoingGame has no Name and no Score. Applying them
                            // unguarded stored the name as undefined and reset the header score
                            // to zero on every question selection. The score's own messages are
                            // ScoreChanged and UpdatePlayersList; the name's is InfoSetResult.
                            if (message.StartGame.Name != null) {
                                window.pqStore.setItem('name', message.StartGame.Name);
                                document.getElementById('select_question_player_group_name').textContent = message.StartGame.Name;
                            }

                            if (message.StartGame.Score != null) {
                                document.getElementById('select_question_player_group_score').textContent = message.StartGame.Score;
                                setMyScore(message.StartGame.Score);
                            }

                            goTo('SELECT_QUESTION_PLAYER', { selector: message.StartGame.Selector });
                        }
                    } else if (command == "PlayerStartedAnswering") {
                        isInAnsweringState = true;
                        answeringSeq = lastCanAnswerSequenceNumber;

                        if (isHost)
                            goTo('PLAYER_ANSWERS_HOST', { player: message.PlayerStartedAnswering.AnsweringPlayer, answer: message.PlayerStartedAnswering.Answer });
                        else if (isPlayer && message.PlayerStartedAnswering.IsYou) {
                            if (window.teamMode && !window.amCaptain)
                                // Captain types the answer; teammates suggest a version instead.
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'suggest_to_captain' });
                            else
                                goTo('YOU_ANSWER');
                        }
                    } else if (command == "PlayerStoppedAnswering") {
                        // Check sequence number to avoid processing stale messages
                        const stoppedSeq = message.PlayerStoppedAnswering ? message.PlayerStoppedAnswering.SequenceNumber : undefined;

                        // A stop is a stop: release the answering latch before any stale return,
                        // otherwise one lost stop suppresses every later CanAnswer for this client.
                        const wasAnswering = isInAnsweringState;
                        const priorAnsweringSeq = answeringSeq;

                        isInAnsweringState = false;
                        answeringSeq = -1;

                        if (!shouldProcessCanAnswerMessage(stoppedSeq)) {
                            return;
                        }

                        // Drop a stale stop from a prior answering session while the input is live.
                        if (wasAnswering && typeof stoppedSeq === 'number' && stoppedSeq < priorAnsweringSeq) {
                            return;
                        }

                        if (isHost) {
                            goTo('QUESTION_SELECTED');
                            showOverlay('dismiss_question_group');
                        } else if (isPlayer) {
                            var pst = message.PlayerStoppedAnswering || {};
                            var pstCant = pst.TriedToAnswer || pst.WasCorrect;
                            if (teamScreenFor('CAN_ANSWER', 'TEAMMATE_SUGGEST') === 'TEAMMATE_SUGGEST') {
                                if (pstCant)
                                    // Team already answered/failed — no buzzer, no suggestions.
                                    goTo('TEAMMATE_READONLY', { cantAnswer: true });
                                else
                                    // Re-open window: keep buzz + suggestion available.
                                    goTo('TEAMMATE_SUGGEST', { showBuzzer: true, label: 'your_suggestion' });
                            } else {
                                goTo('CAN_ANSWER', { triedToAnswer: pst.TriedToAnswer, wasCorrect: pst.WasCorrect });
                            }
                        }
                    } else if (command == "StartCatInPoke") {
                        // The meta belongs to the question, not to the screen: setting it here
                        // fills the panel for the picker, the onlookers and the team-mates alike.
                        setQuestionMeta(message.StartCatInPoke.Theme, message.StartCatInPoke.Price, 'payload');

                        // The team is one player to the host, so CanSelect reaches every member.
                        // Only the captain picks, so the team-mate test comes first.
                        if (window.teamMode && !window.amCaptain && !isHost) {
                            goTo('TEAMMATE_READONLY');
                        } else if (message.StartCatInPoke.CanSelect) {
                            goTo('CAT_IN_POKE_HOST', message.StartCatInPoke);
                        } else {
                            goTo('CAT_IN_POKE_PLAYER', message.StartCatInPoke);
                        }
                    } else if (command == "StartAuction") {
                        // Theme only: while the bidding is open the question is worth whatever
                        // the last bid says, and that number is already on the auction card.
                        setQuestionMeta(message.Auction.Theme, '');

                        if (isHost)
                            goTo('AUCTION_HOST', { theme: message.Auction.Theme });
                        else if (isPlayer) {
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_READONLY');
                            } else {
                                goTo('AUCTION_PLAYER', message.Auction);
                            }
                        }
                    } else if (command == "AuctionHighestBid") {
                        setQuestionMeta(message.Auction.Theme, '');

                        if (isPlayer) {
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_READONLY');
                            } else {
                                goTo('AUCTION_PLAYER', message.Auction);
                            }
                        }
                    } else if (command == "AllQuestionsAnswered") {
                        if (isHost)
                            goTo('ALL_QUESTIONS_ANSWERED_HOST');
                        else if (isPlayer)
                            goTo('ALL_QUESTIONS_ANSWERED_PLAYER');
                    } else if (command == "SequenceStarted") {
                        if (isHost)
                            goTo('SEQUENCE_HOST');
                        else if (isPlayer)
                            goTo('SEQUENCE_PLAYER');
                    } else if (command == "AllHere") {
                        gameStarted = true;

                        goTo('APPLAUSE');

                        // if (isHost)
                        //     goTo('SEQUENCE_HOST');
                        // else if (isPlayer)
                        //     goTo('SEQUENCE_PLAYER');
                    } else if (command == "FinalRoundStartRemovingThemes") {
                        if (message.FinalRoundStartRemovingThemes.CanRemoveThemes)
                            goTo('FINAL_ROUND_THEMES_HOST', { themes: message.FinalRoundStartRemovingThemes.Themes, playerName: message.FinalRoundStartRemovingThemes.PlayerName });
                        else
                            goTo('FINAL_ROUND_THEMES_PLAYER');
                    } else if (command == "FinalRoundStartBidding") {
                        if (isHost)
                            goTo('FINAL_BID_HOST');
                        else if (isPlayer) {
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_READONLY');
                            } else {
                                goTo('FINAL_BID_PLAYER', message.FinalRoundStartBidding);
                            }
                        }
                    } else if (command == "FinalRoundNotEnoughPoints") {
                        if (isPlayer)
                            goTo('NOT_ENOUGH_POINTS');
                    } else if (command == "FinalRoundBidConfirmed") {
                        if (isPlayer)
                            goTo('FINAL_BID_CONFIRMED', { bid: message.FinalRoundBidConfirmed.Bid });
                    } else if (command == "FinalRoundStartAnswering") {
                        // Тема выжившей темы финала. Её видел только тот, кто сделал последнее
                        // удаление; у всех остальных метка держала тему ПРОШЛОГО вопроса. Плашка
                        // в этом состоянии не показывается (show не содержит question_selected_group),
                        // так что экран не меняется — меняется факт, который на нём записан.
                        if (message.FinalRoundStartAnswering && message.FinalRoundStartAnswering.Theme)
                            setQuestionMeta(message.FinalRoundStartAnswering.Theme, '', 'payload');

                        if (isHost)
                            goTo('FINAL_ROUND_ANSWERING_HOST');
                        else if (isPlayer) {
                            resetTeamSuggestions();
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'suggest_to_captain' });
                            } else {
                                goTo('FINAL_ROUND_ANSWERING_PLAYER', { bid: message.FinalRoundStartAnswering.Bid });
                            }
                        }
                    } else if (command == "FinalRoundAnswerConfirmed") {
                        if (isPlayer)
                            goTo('FINAL_ROUND_ANSWER_CONFIRMED', { answer: message.FinalRoundAnswerConfirmed.Answer });
                    } else if (command == "FinalRoundDecideAnswer") {
                        if (isHost)
                            goTo('FINAL_ROUND_DECIDE_ANSWER', message.FinalRoundDecideAnswer);
                    } else if (command == "DisplayFinalResult") {
                        // The podium screen is gone: StartApplause lands right behind this
                        // message and replaced it on screen anyway.
                    } else if (command == "StartApplause") {
                        goTo('APPLAUSE');
                    } else if (command == "StopApplause") {
                        if (isHost)
                            goTo('SEQUENCE_HOST');
                        else if (isPlayer)
                            goTo('SEQUENCE_PLAYER');
                    } else if (command == "CameraRoster") {
                        ShowCameraButton(message.CameraRoster.Cameras, message.CameraRoster.IsEnabled)
                    } else if (command == "StartCuriosity") {
                        if (isHost)
                            goTo('CURIOSITY', { themes: message.StartCuriosity.Themes });
                    } else if (command == "ContinueOrEndGame") {
                        if (isHost)
                            goTo('CONTINUE_OR_END');
                    } else if (command == "StartIntroducingThemes") {
                        if (isHost)
                            goTo('INTRODUCE_THEMES', { themes: message.StartIntroducingThemes.Themes });
                    } else if (command == "DisplayCuriosityAnswer") {
                        if (isHost)
                            goTo('DISPLAY_CURIOSITY_ANSWER');
                    } else if (command == "UpdatePlayersList") {
                        window.pqStandings = message.Players || [];
                        reconcileMyScoreFrom(window.pqStandings);
                        pqReuploadCustomAvatarIfNeeded(window.pqStandings);
                        if (isHost)
                            CreatePlayersForScoreChange(message.Players);
                        if (currentState === 'ALL_QUESTIONS_ANSWERED_HOST' || currentState === 'ALL_QUESTIONS_ANSWERED_PLAYER')
                            renderStandings();
                    } else if (command == "AnswerRevealed") {
                        if (isHost)
                            showOverlay('skip_displaying_group');
                    } else if (command == "StartMultipleChoice") {
                        // The plaque belongs to the question, not to the screen: set it for every
                        // role, team-mates included, and before goTo — refreshQuestionMeta() runs in
                        // the tail of goTo and draws whatever is set by then.
                        setQuestionMeta(message.StartMultipleChoice.Theme, message.StartMultipleChoice.Price, 'payload');

                        if (isHost)
                            goTo('MULTIPLE_CHOICE_HOST');
                        else if (isPlayer) {
                            resetTeamSuggestions();
                            var mcData = { options: message.StartMultipleChoice.Options, question: message.StartMultipleChoice.Question };
                            if (teamScreenFor('x', 'TEAMMATE_SUGGEST') === 'TEAMMATE_SUGGEST') {
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'your_suggestion' });
                            } else {
                                goTo('MULTIPLE_CHOICE_PLAYER', mcData);
                            }
                        }
                    } else if (command == "MultipleChoiceVoteAccepted") {
                        if (isPlayer)
                            goTo('VOTE_ACCEPTED');
                    } else if (command == "StartNumberGuess") {
                        // The plaque belongs to the question, not to the screen: set it for every
                        // role, team-mates included, and before goTo — refreshQuestionMeta() runs in
                        // the tail of goTo and draws whatever is set by then.
                        setQuestionMeta(message.StartNumberGuess.Theme, message.StartNumberGuess.Price, 'payload');

                        if (isHost)
                            goTo('NUMBER_GUESS_HOST');
                        else if (isPlayer) {
                            resetTeamSuggestions();
                            if (teamScreenFor('x', 'TEAMMATE_SUGGEST') === 'TEAMMATE_SUGGEST') {
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'your_suggestion' });
                            } else {
                                goTo('NUMBER_GUESS_PLAYER', { min: message.StartNumberGuess.MinValue });
                            }
                        }
                    } else if (command == "NumberGuessMade") {
                        if (isPlayer)
                            goTo('GUESS_ACCEPTED');
                    } else if (command == "DecideFinalPlayersGroup") {
                        if (isHost)
                            goTo('DECIDE_FINAL_PLAYERS');
                    } else if (command == "RevealingCluesStarted") {
                        // The plaque belongs to the question, not to the screen: set it for every
                        // role, team-mates included, and before goTo — refreshQuestionMeta() runs in
                        // the tail of goTo and draws whatever is set by then.
                        setQuestionMeta(message.RevealingCluesStarted.Theme, message.RevealingCluesStarted.Price, 'payload');

                        if (isHost)
                            goTo('REVEALING_CLUES_HOST');
                        else if (isPlayer) {
                            resetTeamSuggestions();
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'your_suggestion' });
                            } else {
                                goTo('REVEALING_CLUES_PLAYER', { clue: message.RevealingCluesStarted.Clue, isLastClue: message.RevealingCluesStarted.IsLastClue });
                            }
                        }
                    } else if (command == "RevealingCluesDecideAnswer") {
                        if (isHost)
                            goTo('REVEALING_CLUES_DECIDE', { player: message.RevealingCluesDecideAnswer.Player, playerAnswer: message.RevealingCluesDecideAnswer.PlayerAnswer, rightAnswer: message.RevealingCluesDecideAnswer.RightAnswer });
                    } else if (command == "RevealingCluesConfirmGuess") {
                        if (isPlayer)
                            goTo('REVEALING_CLUES_CHOICE_MADE');
                    } else if (command == "CentralInformation") {
                        setCentralInformation(message.CentralInformation && message.CentralInformation.State);
                    } else {
                        console.log("Unknown command: " + message.Command)
                    }
                } else {
                    console.log("Unknown message: " + message)
                }
            }
        }
    }

    function onSocketClose(event) {
        if (event && event.target && event.target !== socket)
            return;

        connecting = false;
        // CONN-06: Do NOT reset inGame/gameStarted on wasClean.
        // Matchmaker sets player.socket = None on disconnect but keeps the player in the game.
        // Resetting inGame here destroys the reconnect path.

        if (reconnectStableTimerId) {
            clearTimeout(reconnectStableTimerId);
            reconnectStableTimerId = null;
        }

        // CONN-01: Exponential backoff capped at 30s with jitter
        const BASE_WAIT_MS = 1000;
        const MAX_RECONNECT_WAIT_MS = 30000;
        const jitter = Math.random() * 1000;
        const waitTime = Math.min(BASE_WAIT_MS * Math.pow(2, reconnectAttempt), MAX_RECONNECT_WAIT_MS) + jitter;
        reconnectAttempt++;

        console.log(JSON.stringify(event) + " " + event.code);

        if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
            showReconnectExhausted();
            return;
        }

        setConnectionDotState('reconnecting');

        // CONN-07: Show disconnect toast with countdown when in-game
        if (inGame) {
            showDisconnectedToast(Math.ceil(waitTime / 1000));
        }

        setTimeout(createSocket, waitTime);
    }

    function updateConnectionScreen() {
        var screen = document.getElementById('reconnection_screen');
        if (!screen) return;

        if (reconnectExhausted) {
            screen.hidden = false;
            return;
        }

        screen.hidden = !(inGame && connecting);
    }

    function showReconnectExhausted() {
        reconnectExhausted = true;

        if (disconnectCountdownIntervalId) {
            clearInterval(disconnectCountdownIntervalId);
            disconnectCountdownIntervalId = null;
        }

        setConnectionDotState('');

        var screen = document.getElementById('reconnection_screen');
        var waiting = document.getElementById('reconnect_waiting');
        var countdown = document.getElementById('reconnect_countdown');
        var terminal = document.getElementById('reconnect_terminal');

        if (screen) screen.hidden = false;
        if (waiting) waiting.hidden = true;
        if (countdown) countdown.hidden = true;
        if (terminal) terminal.hidden = false;
    }

    function hideReconnectTerminal() {
        var waiting = document.getElementById('reconnect_waiting');
        var countdown = document.getElementById('reconnect_countdown');
        var terminal = document.getElementById('reconnect_terminal');

        if (terminal) terminal.hidden = true;
        if (waiting) waiting.hidden = false;
        if (countdown) { countdown.hidden = false; countdown.textContent = '...'; }
    }

    /**
     * The one exit from a game. Called when the matchmaker reports game_id: null and, as a fast path on
     * the happy scenario, when the host's HostLeftGame arrives. Everything resetGameState() deliberately
     * preserves across a RECONNECT must be cleared here — a reconnect returns to the same game, this
     * does not, and a carried-over role starts the next game as somebody else.
     */
    function onGameEnded(reason) {
        console.log('Game ended (' + reason + ')');

        inGame = false;
        gameStarted = false;
        startedNewGame = false;
        // PQRevamped: forget the game id together with the game — RefreshData and
        // handleRefresh no-op on a falsy id, so a refresh after game over stays silent
        // instead of provoking "Game not found". (The button itself is hidden by the
        // goTo('ENTER_ID') below via PQ_REFRESH_HIDDEN_STATES.)
        try { window.pqGameId = null; } catch (e) { /* ignore */ }
        // PQRevamped: clear the one-shot auto-resume latch so the next session can re-arm.
        try { window._pqAutoResumeSent = false; } catch (e) { /* ignore */ }

        window.teamMode = false;
        window.myTeam = null;
        window.amCaptain = false;
        window.teams = [];
        window.teamGameInProgress = false;
        window.teamSuggestions = [];
        window.teamPressed = {};
        window.allowCustomAvatars = true;

        qrJoinGameId = null;
        qrJoinAwaitingPassword = false;

        try { window.pqStore.removeItem('role'); } catch (e) { /* ignore */ }

        resetAnsweringTracking();
        hideQrPasswordPrompt();
        clearGameQueryParam();

        if (disconnectCountdownIntervalId) {
            clearInterval(disconnectCountdownIntervalId);
            disconnectCountdownIntervalId = null;
        }

        // Must precede updateConnectionScreen(): a stale terminal flag keeps the blocking overlay
        // pinned open over ENTER_ID, and the game is over, so there is nothing left to reconnect to.
        reconnectExhausted = false;
        reconnectAttempt = 0;

        hideReconnectTerminal();

        var reconnectScreen = document.getElementById('reconnection_screen');
        if (reconnectScreen) reconnectScreen.hidden = true;

        updateConnectionScreen();

        goTo('ENTER_ID');

        // PQRevamped: when the host leaves, smoothly return everyone to the main menu
        // without reloading the page. A reload would re-create the WebSocket, which the
        // server has historically counted as "left without bidding" / "PASS" mid-round.
        if (reason === 'host-left' && typeof pqReturnToMainMenuAfterHostLeft === 'function') {
            try { pqReturnToMainMenuAfterHostLeft(); } catch (e) { console.error('[pqReturnToMainMenuAfterHostLeft]', e); }
        }
    }

    // PQRevamped: Auto-redirect to main menu when host leaves. Belt-and-suspenders on
    // top of upstream's own goTo('ENTER_ID') so that, if a stray overlay keeps ENTER_ID
    // hidden, the player still gets a clean main menu a moment later. Closes the
    // WebSocket gracefully (no new connection) and dismisses any open modals.
    function pqReturnToMainMenuAfterHostLeft() {
        try {
            // Close any modal that might be open over the game state (custom avatar, leave-confirm, popup).
            try { if (typeof CloseCustomAvatarModal === 'function') CloseCustomAvatarModal(); } catch (e) { /* ignore */ }
            try { if (typeof CancelLeaveGame === 'function') CancelLeaveGame(); } catch (e) { /* ignore */ }
            var pop = document.getElementById('popup-overlay');
            if (pop) pop.hidden = true;
            // Gracefully close the WebSocket so the server records an intentional disconnect
            // rather than a forced one (the latter is what tipped server-side PASS counters
            // in the original fork-on).
            try {
                if (window.socket && typeof window.socket.close === 'function') {
                    try { window.socket.onclose = null; } catch (e) { /* ignore */ }
                    try { window.socket.close(); } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore */ }
            // A short delay so the player can see the game-over state, then re-issue goTo
            // in case ENTER_ID didn't actually render (custom-avatar modal kept blocking it).
            setTimeout(function () {
                try { goTo('ENTER_ID'); } catch (e) { /* ignore */ }
                try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
            }, 1500);
        } catch (e) { console.error('[pqReturnToMainMenuAfterHostLeft]', e); }
    }
    window.pqReturnToMainMenuAfterHostLeft = pqReturnToMainMenuAfterHostLeft;

    function RetryReconnect() {
        reconnectExhausted = false;
        hideReconnectTerminal();
        reconnectAttempt = 0;
        createSocket();
    }

    function LeaveGameFromTerminal() {
        try { window.pqStore.removeItem('state'); } catch (e) { /* ignore */ }

        if (socket && socket.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({'Leave': null})); } catch (e) { /* ignore */ }
        }

        setTimeout(function () { location.reload(); }, 200);
    }

    window.RetryReconnect = RetryReconnect;
    window.LeaveGameFromTerminal = LeaveGameFromTerminal;

    // MUXP-02: Connection status dot — three states driven by WebSocket lifecycle
    function setConnectionDotState(state) {
        var dot = document.getElementById('connection_dot');
        if (!dot) return;
        dot.classList.remove('connected', 'reconnecting');
        if (state === 'connected') dot.classList.add('connected');
        else if (state === 'reconnecting') dot.classList.add('reconnecting');
    }

    function showDisconnectedToast(totalSeconds) {
        const reconnectionScreen = document.getElementById('reconnection_screen');
        const countdownLabel = document.getElementById('reconnect_countdown');
        if (!reconnectionScreen || !countdownLabel) return;

        let remaining = totalSeconds;
        countdownLabel.textContent = remaining;
        reconnectionScreen.hidden = false;

        // Clear any previous countdown
        if (disconnectCountdownIntervalId) {
            clearInterval(disconnectCountdownIntervalId);
        }

        disconnectCountdownIntervalId = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(disconnectCountdownIntervalId);
                disconnectCountdownIntervalId = null;
                countdownLabel.textContent = '...';
            } else {
                countdownLabel.textContent = remaining;
            }
        }, 1000);
    }

    function initSetInfoChangeTracking() {
        const nameInput = document.getElementById('player_name');
        const introInput = document.getElementById('player_intro');

        // Remove old listeners to avoid duplicates
        if (nameInput && !nameInput._infoChangeListener) {
            nameInput._infoChangeListener = function() {
                if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
            };
            nameInput.addEventListener('input', nameInput._infoChangeListener);
        }
        if (introInput && !introInput._infoChangeListener) {
            introInput._infoChangeListener = function() {
                if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
            };
            introInput.addEventListener('input', introInput._infoChangeListener);
        }

        // Initial button state
        if (typeof updateSetInfoButtonState === 'function') updateSetInfoButtonState();
    }

    function DisplayConnectedPlayersListHostPage(message) {
        if (document.getElementById('all_here_host_group').hidden
            && document.getElementById('all_here_player_group').hidden) return;
        CreatePlayersListForHost(message.Players);
        document.getElementById('players_list_host_group').hidden = false;
    }

    function UpdateAuctionPlayerPage(highestBidderId, highestBidderName, highestBid, yourPoints, youPass, yourTurn) {
        console.log("UpdateAuctionPlayerPage yourId=" + window.playerId + " highestBidderId=" + highestBidderId + " highestBid=" + highestBid + " yourPoints=" + yourPoints + " youPass=" + youPass);
        window.auction.update(highestBidderId, highestBid, yourPoints, youPass, yourTurn);
        window.yourPoints = yourPoints;
        window.auctionPage.update(window.auction, yourPoints, highestBidderName);
    }

    // ---------- Auction bid ladder ----------
    // The reachable bids are 1, 5, 10, 15, 20 … : the first legal bid is 1, and from there
    // every step is 5 and lands on a multiple of 5. The host's own rule is only "beat the
    // leader", so its minimum is often off the ladder (leader at 5 → minimum 6 → the first
    // reachable bid is 10, never 6 and never 12). Everything below expresses that one fact:
    // the +/- buttons, the min/max/step attributes and a hand-typed number all pass through
    // the same two snap functions, so the value can never come to rest off the ladder.

    var PQ_BID_STEP = 5;

    // Lowest rung that is >= v.
    function pqBidSnapUp(v) {
        if (!isFinite(v) || v <= 1) return 1;
        if (v <= PQ_BID_STEP) return PQ_BID_STEP;
        return Math.ceil(v / PQ_BID_STEP) * PQ_BID_STEP;
    }

    // Highest rung that is <= v.
    function pqBidSnapDown(v) {
        if (!isFinite(v) || v < PQ_BID_STEP) return 1;
        return Math.floor(v / PQ_BID_STEP) * PQ_BID_STEP;
    }

    // The two ends of the ladder for the auction as it stands: the floor is the lowest rung
    // that still beats the leader, the ceiling the highest rung the player can afford.
    function pqBidBounds(input) {
        var rawMin = parseInt(input.min, 10);
        var rawMax = parseInt(input.max, 10);
        if (isNaN(rawMin) || rawMin < 1) rawMin = 1;
        if (isNaN(rawMax)) rawMax = Number.MAX_SAFE_INTEGER;
        if (rawMax < rawMin) rawMax = rawMin;

        var floor = pqBidSnapUp(rawMin);
        var ceiling = pqBidSnapDown(rawMax);

        // Degenerate case: the host's minimum and the player's score are so close that no
        // rung fits between them (minimum 7, score 8). A legal off-ladder bid beats no bid
        // at all, so the raw bound is used and the ladder resumes on the next auction.
        if (floor > rawMax) return { floor: rawMax, ceiling: rawMax };
        if (ceiling < floor) ceiling = floor;
        return { floor: floor, ceiling: ceiling };
    }

    function pqBidCurrent(input, bounds) {
        var current = parseInt(input.value, 10);
        return isNaN(current) ? bounds.floor : current;
    }

    // A button at the end of the ladder is dead and says so. The floor is 1 while nobody has
    // bid, and the leader's rung once somebody has — the same test covers both.
    function pqBidSyncStepper() {
        var input = document.getElementById('your_bid');
        if (!input) return;
        var bounds = pqBidBounds(input);
        var current = pqBidCurrent(input, bounds);
        var minus = document.getElementById('pq_bid_minus');
        var plus = document.getElementById('pq_bid_plus');
        if (minus) minus.disabled = current <= bounds.floor;
        if (plus) plus.disabled = current >= bounds.ceiling;
    }

    // The ladder belongs to the two step buttons. A typed value is only held to the host's
    // own rule — beat the leader, stay inside your score — because snapping it up rejected
    // legal bids: with the leader on 15 the field opened on 20 and a typed 16 bounced back
    // to 20, which reads as the field refusing to be edited.
    function pqBidNormalize() {
        var input = document.getElementById('your_bid');
        if (!input) return;
        var rawMin = parseInt(input.min, 10);
        var rawMax = parseInt(input.max, 10);
        if (isNaN(rawMin) || rawMin < 1) rawMin = 1;
        if (isNaN(rawMax)) rawMax = Number.MAX_SAFE_INTEGER;

        var v = parseInt(input.value, 10);
        if (isNaN(v)) v = rawMin;
        if (v < rawMin) v = rawMin;
        if (v > rawMax) v = rawMax;
        input.value = v;
        pqBidSyncStepper();
    }

    // Called once per Auction message with the host's raw rule. Writes every attribute the
    // field has, so nothing about the ladder is left to a default.
    function pqBidApply(rawMin, rawMax) {
        var input = document.getElementById('your_bid');
        if (!input) return;
        // min/max stay the host's raw rule, so typing any legal number is allowed. The
        // ladder is derived from them by pqBidBounds() and drives the two step buttons only,
        // which is why `step` is left free — a step attribute would make the browser reject
        // the off-rung values this field now accepts on purpose.
        input.min = rawMin;
        input.max = rawMax;
        input.step = 'any';

        var bounds = pqBidBounds(input);
        input.value = bounds.floor;
        pqBidSyncStepper();
    }

    function AuctionBidStep(direction) {
        var input = document.getElementById('your_bid');
        if (!input) return;
        var bounds = pqBidBounds(input);
        var current = pqBidCurrent(input, bounds);

        var next;
        if (direction > 0) next = (current < bounds.floor) ? bounds.floor : pqBidSnapUp(current + 1);
        else next = (current > bounds.ceiling) ? bounds.ceiling : pqBidSnapDown(current - 1);

        if (next < bounds.floor) next = bounds.floor;
        if (next > bounds.ceiling) next = bounds.ceiling;
        input.value = next;
        pqBidSyncStepper();
    }

    window.AuctionBidStep = AuctionBidStep;
    window.pqBidApply = pqBidApply;
    window.pqBidNormalize = pqBidNormalize;
    window.pqBidSyncStepper = pqBidSyncStepper;

    /**
     * "Tap" (быстрое касание) вместо "touchstart/pointerdown".
     * Это позволяет нормально скроллить списки: если палец сдвинулся — считаем это прокруткой и не вызываем действие.
     */
    function bindTapHandler(element, onTap, options) {
        var moveThresholdPx = (options && options.moveThresholdPx) || 12;
        var maxPressMs = (options && options.maxPressMs) || 800;

        var tracking = false;
        var moved = false;
        var startX = 0;
        var startY = 0;
        var startAt = 0;
        var activePointerId = null;

        function reset() {
            tracking = false;
            moved = false;
            startX = 0;
            startY = 0;
            startAt = 0;
            activePointerId = null;
        }

        function exceedsMoveThreshold(x, y) {
            return Math.abs(x - startX) > moveThresholdPx || Math.abs(y - startY) > moveThresholdPx;
        }

        // Pointer Events cover mouse + touch on all modern browsers (including mobile).
        if (window.PointerEvent) {
            var onPointerDown = function (event) {
                // Only primary pointer and primary button (avoid right click / multi-touch).
                if (event.isPrimary === false) return;
                if (event.button != null && event.button !== 0) return;

                tracking = true;
                moved = false;
                activePointerId = event.pointerId;
                startX = event.clientX;
                startY = event.clientY;
                startAt = (window.performance && performance.now) ? performance.now() : Date.now();
            };

            var onPointerMove = function (event) {
                if (!tracking) return;
                if (activePointerId != null && event.pointerId !== activePointerId) return;
                if (!moved && exceedsMoveThreshold(event.clientX, event.clientY)) moved = true;
            };

            var onPointerUp = function (event) {
                if (!tracking) return;
                if (activePointerId != null && event.pointerId !== activePointerId) return;

                var now = (window.performance && performance.now) ? performance.now() : Date.now();
                var pressMs = now - startAt;
                var shouldTap = !moved && pressMs <= maxPressMs;

                reset();

                if (shouldTap) onTap(event);
            };

            var onPointerCancel = function (event) {
                if (!tracking) return;
                if (activePointerId != null && event.pointerId !== activePointerId) return;
                reset();
            };

            element.addEventListener('pointerdown', onPointerDown, {passive: true});
            element.addEventListener('pointermove', onPointerMove, {passive: true});
            element.addEventListener('pointerup', onPointerUp, {passive: true});
            element.addEventListener('pointercancel', onPointerCancel, {passive: true});

            return function unbind() {
                element.removeEventListener('pointerdown', onPointerDown);
                element.removeEventListener('pointermove', onPointerMove);
                element.removeEventListener('pointerup', onPointerUp);
                element.removeEventListener('pointercancel', onPointerCancel);
            };
        }

        // Fallback: rely on click. Browsers won't fire click when user scrolls.
        var onClick = function (event) {
            onTap(event);
        };

        element.addEventListener('click', onClick, false);
        return function unbind() {
            element.removeEventListener('click', onClick, false);
        };
    }

    function CreateQuestionsFromJson(json) {
        ClearQuestionTable();
        var table = document.getElementById("questions_table");

        for (var theme of json) {
            var row = document.createElement("div");
            let questionsItemWrapper = document.createElement('div');
            questionsItemWrapper.classList.add('questions-items');

            var header = document.createElement("div");
            row.classList.add('questions-row');
            header.classList.add('questions-row-header');
            header.textContent = theme.theme;
            row.appendChild(header);

            for (var question of theme.questions) {
                var questionId = question.id;
                var price = document.createTextNode(question.price);
                var item = document.createElement("div");
                item.classList.add('questions-row-item');

                if (question.wasAnswered) {
                    item.classList.add('is-answered');
                } else {
                    (function (themeId, qId, el) {
                        var unbind = null;
                        function handler() {
                            SelectQuestion(themeId, qId);
                            el.classList.add('is-answered');
                            if (unbind) unbind();
                        }

                        unbind = bindTapHandler(el, handler);
                    })(theme.id, questionId, item);
                }

                item.appendChild(price);
                questionsItemWrapper.appendChild(item);
            }

            row.appendChild(questionsItemWrapper);
            table.appendChild(row);
        }
    }

    function CreatePlayersListForHost(players) {
        ClearPlayersListHostTable();
        var table = document.getElementById("players_list_host_group");

        for (var player of players) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('players-list-user-wrapper');
            th.classList.add('players-list-user');
            var playerName = document.createTextNode(t('kick') + "\n" + player.Name);
            var playerId = player.Id;
            th.appendChild(playerName);
            tr.appendChild(th);

            (function (pid, el) {
                var unbind = null;
                function handler() {
                    KickPlayer(pid);
                    el.style.background = answeredColor;
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(playerId, tr);

            table.appendChild(tr);
        }
    }

    function CreateMultipleChoiceOptions(options) {
        ClearMultipleChoiceOptionsTable();
        var index = 0;
        var table = document.getElementById("multiple_choice_options_group");

        for (var option of options) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('final-round-question-wrapper');
            th.classList.add('final-round-question');
            var optionName = document.createTextNode(option);
            th.appendChild(optionName);
            tr.appendChild(th);

            (function (idx, el) {
                var unbind = null;
                function handler() {
                    window._mcVoted = true;
                    MultipleChoiceVote(idx);
                    el.classList.add('is-picked');
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(index, tr);

            index++;
            table.appendChild(tr);
        }
    }

    function CreatePlayersForCatInPoke(players) {
        ClearCatInPokeTable();
        var table = document.getElementById("cat_in_poke_host_group");
        var randomPlayer = GetRandomPlayer(players);
        CreateCatInPokeElement(table, t('random'), randomPlayer.id, true);
        for (var player of players) {
            CreateCatInPokeElement(table, player.name, player.id, false);
        }
    }

    function GetRandomPlayer(players) {
        if (players.length === 0) {
            throw new Error("Can't pick random from an empty array of players.");
        }

        return players[Math.floor(Math.random() * players.length)];
    }

    function CreateCatInPokeElement(table, playerName, playerId, isRandom) {
        var tr = document.createElement("div");
        var th = document.createElement("div");
        if (isRandom) {
            tr.classList.add('cat-in-poke-random-wrapper');
            th.classList.add('cat-in-poke-random');
        } else {
            tr.classList.add('cat-in-poke-user-wrapper');
            th.classList.add('cat-in-poke-user');
        }
        var textNode = document.createTextNode(playerName);
        th.appendChild(textNode);
        tr.appendChild(th);

        (function (pid, el, rnd) {
            var unbind = null;
            function handler() {
                SelectCatInPokeOwner(pid, rnd);
                el.classList.add('is-picked');
                if (unbind) unbind();
            }

            unbind = bindTapHandler(el, handler);
        })(playerId, tr, isRandom);

        table.appendChild(tr);
    }

    function CreateThemesForLastRound(themes) {
        ClearFinalRoundThemesTable();
        var index = 0;
        var table = document.getElementById("final_round_themes_group");

        for (var theme of themes) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('final-round-question-wrapper');
            th.classList.add('final-round-question');
            var themeName = document.createTextNode(theme);
            th.appendChild(themeName);
            tr.appendChild(th);

            (function (idx, el) {
                var unbind = null;
                function handler() {
                    RemoveFinalRoundTheme(idx);
                    el.classList.add('is-picked');
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(index, tr);

            index++;
            table.appendChild(tr);
        }
    }

    function CreateTopicsToIntroduceList(themes) {
        ClearThemesToIntroduceTable();
        var table = document.getElementById("themes_to_introduce_group");
        var index = 0;

        for (var theme of themes) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('final-round-question-wrapper');
            th.classList.add('final-round-question');
            var themeName = document.createTextNode(theme);
            th.appendChild(themeName);
            tr.appendChild(th);

            (function (idx, el) {
                var unbind = null;
                function handler() {
                    HostIntroducedTheme(idx);
                    el.classList.add('is-picked');
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(index, tr);

            table.appendChild(tr);
            index++;
        }
    }

    function CreateThemesForCuriosity(themes) {
        ClearFinalRoundThemesTable();
        var table = document.getElementById("final_round_themes_group");
        var index = 0;

        for (var theme of themes) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('final-round-question-wrapper');
            th.classList.add('final-round-question');
            var themeName = document.createTextNode(theme);
            th.appendChild(themeName);
            tr.appendChild(th);

            (function (idx, el) {
                var unbind = null;
                function handler() {
                    NotifyCuriosityTheme(idx);
                    el.classList.add('is-picked');
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(index, tr);

            index++;
            table.appendChild(tr);
        }
    }

    function CreatePlayersForScoreChange(players) {
        ClearScoreChangeTable();
        var table = document.getElementById("change-score-group");

        for (var player of players) {
            var tr = document.createElement("div");
            var th = document.createElement("div");
            tr.classList.add('change-score-user-wrapper');
            th.classList.add('change-score-user');
            var playerName = document.createTextNode(player.Name);
            var playerId = player.Id;
            th.appendChild(playerName);
            tr.appendChild(th);

            (function (pid, el) {
                var unbind = null;
                function handler() {
                    SelectChangeScorePlayer(pid);
                    el.style.background = answeredColor;
                    if (unbind) unbind();
                }

                unbind = bindTapHandler(el, handler);
            })(playerId, tr);

            table.appendChild(tr);
        }
    }

    // The host only steers the camera while the game is running — outside of that the
    // whole control is hidden and the host command is dropped on the host side anyway.
    function ShowCameraButton(roster, isEnabled) {
        var control = document.getElementsByClassName("camera_control")[0];
        if (!control) return;

        control.style.display = isEnabled ? 'inline-block' : 'none';

        if (!isEnabled && window.pqCloseCameraStack) window.pqCloseCameraStack();

        if (createdCameraButtons) return;
        createdCameraButtons = true;
        var dropdown = document.getElementsByClassName("camera_roster")[0];

        for (var data of roster) {
            if (data.IsDisplayed == false) continue;
            var cameraIndex = data.Index;
            var cameraButton = document.createElement("b");
            cameraButton.className = "button color-blue camera-secondary-button";
            cameraButton.nodeType = "button";
            cameraButton.innerText = cameras[cameraIndex];

            // оставить обычный click для камер, если нет проблемы по краям
            cameraButton.addEventListener('click', function (idx) {
                return function () {
                    ChangeCamera(idx);
                };
            }(cameraIndex));

            dropdown.appendChild(cameraButton);
        }
    }

    function setCentralInformation(stateName) {
        var overlay = document.getElementById('central_information_overlay');
        var messageEl = document.getElementById('central_information_message');
        if (!overlay || !messageEl) return;

        var key = stateName ? CENTRAL_INFO_KEYS[stateName] : null;

        if (!key) {
            overlay.classList.remove('visible');
            overlay.setAttribute('aria-hidden', 'true');
            return;
        }

        messageEl.textContent = t(key);
        overlay.setAttribute('aria-hidden', 'false');
        overlay.classList.add('visible');
    }

    var CENTRAL_INFO_KEYS = {
        GeneratingPlayerIntroductions: 'generating_player_introductions'
    };

    function HideAll() {
        // A new screen is coming up, so the next standings render starts a fresh baseline.
        pqDeltaBaseline = null;
        // The synergy layer is page-level, not screen-level: it keeps raining across a
        // screen change while synergy is on, and this is the guarantee that it can never
        // outlive it — no screen change ever leaves a spawn interval running.
        pqSyncSynergyRain();
        document.getElementById('title').textContent = "";
        document.getElementById('undertitle').textContent = "";
        document.querySelector('#emoji_layer').style.display = 'none';
        document.getElementById('player_answer_input').value = "";
        document.getElementById('revealing_clues_input').value = "";
        document.getElementById('number_guess_input').value = "";

        [
            'enter_id_group', 'resume_game_group', 'role_selection_group', 'avatar_group', 'set_info_group',
            'enter_member_name_group', 'team_lobby_group', 'team_create_group',
            'all_here_host_group', 'all_here_player_group', 'select_question_player_group',
            'can_answer_player_group', 'question_selected_group', 'select_question_host_group',
            'player_answers_host_group', 'cat_in_poke_host_group', 'cat_in_poke_player_group',
            'auction_host_group', 'auction_player_group', 'all_questions_answered_host_group',
            'all_questions_answered_player_group', 'you_answer_group', 'right_answer_group',
            'dismiss_question_group', 'skip_displaying_group', 'final_round_themes_group',
            'final_bid_player_group', 'final_round_answer_group', 'final_round_decide_answer_group',
            'get_ready_player_group', 'replay_question_audio_group', 'everyone_bids_group',
            'everyone_answers_group', 'curiosity_or_end_group', 'themes_to_introduce_group',
            'curiosity_answer_group', 'players_list_host_group', 'multiple_choice_options_group',
            'multiple_choice_host_group', 'number_guess_host_group', 'number_guess_player_group',
            'decide_final_players_group', 'stop_guessing_or_end_question_group',
            'guess_or_pass_player_group', 'revealing_clues_decide_answer_group', 'applause_group',
            'teammate_suggest_group', 'teammate_readonly_group'
        ].forEach(id => {
            let el = document.getElementById(id);
            if (el) {
                el.hidden = true;
                el.classList.remove('screen-enter');
            }
        });

        var _suggStrip = document.getElementById('sugg_strip');
        if (_suggStrip) _suggStrip.hidden = true;

        // A screen change collapses the emoji stack, as the design does: HideAll() takes
        // the layer out of the flow and puts it back, and a stack left open would pop its
        // six buttons again on the new screen. emoji.js exposes the closer; it loads after
        // this file, so the guard matters only for a HideAll() before its <script> runs.
        if (typeof window.pqCloseEmojiStack === 'function') window.pqCloseEmojiStack();

        ShowEmojiGroup();
    }

    function InitErrorPopup() {
        errorPopupElements = {
            container: document.getElementById('error_popup'),
            overlay: document.getElementById('error_popup_overlay'),
            message: document.getElementById('error_popup_message'),
            button: document.getElementById('error_popup_button')
        };

        if (!errorPopupElements.container || !errorPopupElements.overlay || !errorPopupElements.message) {
            errorPopupElements = null;
            return;
        }

        if (errorPopupElements.button)
            errorPopupElements.button.addEventListener('click', hideErrorPopup);

        errorPopupElements.overlay.addEventListener('click', hideErrorPopup);
        errorPopupElements.container.addEventListener('transitionend', handleErrorPopupTransitionEnd);
    }

    function showErrorPopup(message) {
        if (!errorPopupElements) return;
        const {container, overlay, message: messageElement} = errorPopupElements;
        const text = message || ERROR_POPUP_DEFAULT_MESSAGE;

        // Support "<BR>" line breaks from localization without using innerHTML.
        if (window.i18n && typeof window.i18n.setTextWithBr === 'function') {
            window.i18n.setTextWithBr(messageElement, text);
        } else {
            messageElement.textContent = String(text ?? '').replace(/<br\s*\/?>/ig, '\n');
        }

        clearTimeout(errorPopupAutoHideTimer);

        container.classList.remove('fade-out');
        overlay.classList.remove('fade-out');
        container.classList.add('visible');
        overlay.classList.add('visible');
        container.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-hidden', 'false');

        errorPopupAutoHideTimer = setTimeout(() => {
            hideErrorPopup();
        }, ERROR_POPUP_AUTO_HIDE_MS);
    }

    function reportError(message) {
        clearAllInlineErrors();
        showErrorPopup(message);
    }

    // Expose to other scripts (commands.js, avatars.js, etc).
    window.showErrorPopup = showErrorPopup;
    window.reportError = reportError;

    function hideErrorPopup() {
        if (!errorPopupElements) return;
        const {container, overlay} = errorPopupElements;

        clearTimeout(errorPopupAutoHideTimer);

        if (!container.classList.contains('visible')) return;

        container.classList.add('fade-out');
        overlay.classList.add('fade-out');
    }

    function handleErrorPopupTransitionEnd(event) {
        if (event.propertyName !== 'opacity' || !errorPopupElements) return;
        if (!errorPopupElements.container.classList.contains('fade-out')) return;

        resetErrorPopupState();
    }

    function resetErrorPopupState() {
        if (!errorPopupElements) return;
        const {container, overlay} = errorPopupElements;

        container.classList.remove('visible', 'fade-out');
        overlay.classList.remove('visible', 'fade-out');

        container.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-hidden', 'true');
    }

    // ===== QR Code Password Prompt =====
    function showQrPasswordPrompt(gameId) {
        var overlay = document.getElementById('qr_password_overlay');
        var modal = document.getElementById('qr_password_modal');
        var label = document.getElementById('qr_password_game_id');
        var input = document.getElementById('qr_password_input');
        var errEl = document.getElementById('qr_password_error');

        if (!overlay || !modal) return;

        if (label) label.textContent = gameId;
        if (input) input.value = '';
        if (errEl) errEl.textContent = '';

        HideAll();
        overlay.hidden = false;
        modal.hidden = false;

        if (input) setTimeout(function() { input.focus(); }, 100);
    }

    function hideQrPasswordPrompt() {
        var overlay = document.getElementById('qr_password_overlay');
        var modal = document.getElementById('qr_password_modal');
        if (overlay) overlay.hidden = true;
        if (modal) modal.hidden = true;
    }

    window.showQrPasswordPrompt = showQrPasswordPrompt;
    window.hideQrPasswordPrompt = hideQrPasswordPrompt;

    function submitQrPassword() {
        var input = document.getElementById('qr_password_input');
        var password = input ? input.value : '';

        if (!qrJoinGameId) return;

        hideQrPasswordPrompt();
        TryJoinGameWithId(qrJoinGameId, password);
    }

    function cancelQrPassword() {
        qrJoinGameId = null;
        qrJoinAwaitingPassword = false;
        hideQrPasswordPrompt();
        goTo('ENTER_ID');
    }

    window.submitQrPassword = submitQrPassword;
    window.cancelQrPassword = cancelQrPassword;

    // Handle Enter key in the QR password input
    (function() {
        var input = document.getElementById('qr_password_input');
        if (input) {
            input.addEventListener('keyup', function(event) {
                if (event.keyCode === 13) {
                    event.preventDefault();
                    submitQrPassword();
                }
            });
        }
    })();

    function ShowEmojiGroup() {
        // gameStarted is memory-only: set on the one-shot AllHere, lost on reload.
        // Derive the same visibility from the live screen so a reload mid-game restores
        // the layer as soon as the server re-sends the current phase (any in-game
        // PAGE_STATE) — no server change needed, unlike APPLAUSE which has no
        // screen-independent derivation. The OR keeps pre-reload behavior bit-identical:
        // where gameStarted was already true nothing changes; where it was lost, the
        // current screen decides. Pre-game screens stay hidden either way.
        var inGameScreen = false;
        try { inGameScreen = !!currentState && !PQ_STRIP_HIDDEN[currentState]; } catch (e) { /* ignore */ }
        document.querySelector('#emoji_layer').style.display = (gameStarted || inGameScreen) ? 'flex' : 'none';
    }

    // Local feedback for a sent emoji. The message itself still goes out through the
    // untouched PlayEmoji(); this only draws the glyph flying up the screen. The glyph
    // is a literal from the markup and is written with textContent, and every node
    // removes itself after the animation.
    function pqFloatEmoji(glyph) {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var el = document.createElement('span');
        el.className = 'pq-floater';
        el.textContent = glyph;
        el.style.setProperty('--x', (24 + Math.round(Math.random() * 40)) + 'px');
        document.body.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1700);
    }

    window.pqFloatEmoji = pqFloatEmoji;

    function ClearQuestionTable() {
        let node = document.getElementById("questions_table");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearPlayersListHostTable() {
        let node = document.getElementById("players_list_host_group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearMultipleChoiceOptionsTable() {
        let node = document.getElementById("multiple_choice_options_group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearCatInPokeTable() {
        let node = document.getElementById("cat_in_poke_host_group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearFinalRoundThemesTable() {
        let node = document.getElementById("final_round_themes_group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearThemesToIntroduceTable() {
        let node = document.getElementById("themes_to_introduce_group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function ClearScoreChangeTable() {
        let node = document.getElementById("change-score-group");
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function InitGameIdInput() {
        var input = document.getElementById("game_id");
        input.addEventListener("keyup", function (event) {
            if (event.keyCode === 13) {
                event.preventDefault();
                document.getElementById("join_game_button").click();
            }
        });
    }

});

// ===== Custom Avatar Modal =====

// PQRevamped: safe wrapper for the inline onclick handlers in game.html.
// The custom_avatar_3d.js is a deferred ES module, so when the user clicks
// before the module finishes loading, the global switchCustomAvatarView is
// not yet defined. The module publishes its API on window.__pqCustomAvatar3D
// (shared namespace) plus fires pq:customAvatar3DReady. This wrapper either
// calls the API directly, or queues the request until ready.
(function pqSetupCustomAvatarTabs() {
    var pending = null;
    function realSwitch(view) {
        if (window.__pqCustomAvatar3D && typeof window.__pqCustomAvatar3D.switchCustomAvatarView === 'function') {
            return window.__pqCustomAvatar3D.switchCustomAvatarView(view);
        }
        if (typeof window.switchCustomAvatarView === 'function') {
            return window.switchCustomAvatarView(view);
        }
        return false;
    }
    function flush() {
        if (pending != null) {
            try { realSwitch(pending); } catch (e) { console.error('[pqSwitchCustomAvatarView]', e); }
            pending = null;
        }
    }
    window.pqSwitchCustomAvatarView = function (view) {
        if (window.__pqCustomAvatar3D && window.__pqCustomAvatar3D.ready) {
            try { realSwitch(view); return; } catch (e) { console.error('[pqSwitchCustomAvatarView]', e); }
        }
        pending = view;
    };
    document.addEventListener('pq:customAvatar3DReady', flush);
    // If the module already published before this listener was attached, pick it up.
    if (window.__pqCustomAvatar3D && window.__pqCustomAvatar3D.ready) flush();
    // Belt-and-suspenders: brief poll in case the namespace is set but flag lags.
    var tries = 0;
    var t = setInterval(function () {
        if (window.__pqCustomAvatar3D && window.__pqCustomAvatar3D.ready) { flush(); clearInterval(t); }
        else if (++tries > 60) clearInterval(t);
    }, 50);
})();

function OpenCustomAvatarModal() {
    var overlay = document.getElementById('custom_avatar_modal_overlay');
    var modal = document.getElementById('custom_avatar_modal');
    if (overlay) overlay.hidden = false;
    if (modal) {
        modal.hidden = false;
        requestAnimationFrame(function() { autoFitButtons(modal); });
        // PQRevamped: restore the user's last tab choice (flat or 3D) when reopening.
        // Falls back to 'flat' if localStorage is unavailable or unset.
        var initialView = 'flat';
        try {
            if (typeof window.getSavedCustomAvatarView === 'function') {
                initialView = window.getSavedCustomAvatarView();
            }
        } catch (e) { /* ignore */ }
        try {
            if (typeof window.pqSwitchCustomAvatarView === 'function') {
                window.pqSwitchCustomAvatarView(initialView);
            } else if (typeof window.switchCustomAvatarView === 'function') {
                window.switchCustomAvatarView(initialView);
            }
        } catch (e) { /* ignore */ }
    }
}




// PQRevamped: Enter-to-send for in-game input fields. The upstream only wires Enter
// on QR-password and join-game, so on phones especially it's a QOL win to bind Enter
// to send the answer / bid / guess / final-answer / revealing-clues.
(function bindEnterToSend() {
    var bindings = [
        { input: 'player_answer_input', action: function (v) { PlayerAnswer(v); } },
        { input: 'final_answer_input',  action: function (v) { FinalRoundAnswer(v); } },
        { input: 'final_bid_input',     action: function (v) { FinalRoundBid(v); } },
        { input: 'number_guess_input',  action: function (v) { NumberGuessMade(v); } },
        { input: 'revealing_clues_input', action: function (v) {
            // Revealing clues: two intents possible (guess vs pass). Mirror what the
            // visible buttons do; here Enter = guess, since the pass button is separate.
            if (typeof RevealingCluesGuessMade === 'function') RevealingCluesGuessMade(v);
        } }
    ];
    for (var i = 0; i < bindings.length; i++) {
        (function (b) {
            var el = document.getElementById(b.input);
            if (!el) return;
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    var v = el.value;
                    if (v === '' || v == null) return;
                    try { b.action(v); } catch (err) { console.error('[Enter]', err); }
                }
            });
        })(bindings[i]);
    }
})();

function CloseCustomAvatarModal() {
    var overlay = document.getElementById('custom_avatar_modal_overlay');
    var modal = document.getElementById('custom_avatar_modal');
    if (overlay) overlay.hidden = true;
    if (modal) modal.hidden = true;
}

function ConfirmCustomAvatar() {
    if (typeof captureCustomAvatarThumbnail === 'function') captureCustomAvatarThumbnail();
    CloseCustomAvatarModal();
    SetInfo();
}

let tooltipDismissed = false;

// Out-of-game screens: refresh re-requests the current game, so there is nothing
// for it to do here. Team states are NOT in this set — a joined player in the team
// lobby is already in a game (game_id is set) and may legitimately re-sync.
var PQ_REFRESH_HIDDEN_STATES = { ENTER_ID: 1, RESUME_GAME: 1, ROLE_SELECTION: 1, SET_INFO: 1 };

// Change-guarded wrapper around updateRefreshButtonVisibility: goTo() calls this on
// every Page transition, but the mobile tooltip inside must only fire the first time
// the button appears, not on every in-game screen change.
function pqSyncRefreshButton(inGameNow) {
    var btn = document.getElementById('refreshButton');
    if (!btn) return;
    var want = !!inGameNow;
    if (btn.classList.contains('active') === want) return;
    updateRefreshButtonVisibility(want);
}

// Show/hide refresh button based on game state
function updateRefreshButtonVisibility(inGame) {
    const refreshButton = document.getElementById('refreshButton');
    const tooltip = document.getElementById('refreshTooltip');

    if (refreshButton) {
        if (inGame) {
            refreshButton.classList.add('active');

            // On mobile, show tooltip for 3 seconds when button first appears
            // (only if not previously dismissed)
            if (!tooltipDismissed && window.matchMedia('(hover: none)').matches) {
                setTimeout(() => {
                    if (tooltip && !tooltip.classList.contains('dismissed')) {
                        tooltip.classList.add('show-mobile');

                        // Auto-hide after 3 seconds
                        setTimeout(() => {
                            tooltip.classList.remove('show-mobile');
                        }, 3000);
                    }
                }, 500);
            }
        } else {
            refreshButton.classList.remove('active');
        }
    }
}

// Handle refresh button click
function handleRefresh() {
    // No active game (it ended and we are back on ENTER_ID, or none joined yet):
    // nothing to re-request — stay fully silent instead of provoking a
    // "Game not found" error from the server. (The button is hidden in these
    // states too; this covers any path that still invokes the handler.)
    if (!window.pqGameId) return;

    const button = document.getElementById('refreshButton');
    const tooltip = document.getElementById('refreshTooltip');

    // Dismiss tooltip permanently
    if (tooltip) {
        tooltip.classList.add('dismissed');
        tooltip.classList.remove('show-mobile');
        tooltipDismissed = true;

        // Store in localStorage so it stays dismissed across sessions
        localStorage.setItem('refreshTooltipDismissed', 'true');
    }

    // Add spinning animation
    if (button) {
        button.classList.add('spinning');

        // Remove spinning animation after it completes
        setTimeout(() => {
            button.classList.remove('spinning');
        }, 600);
    }

    // Call the RefreshData function from commands.js
    RefreshData();
}

// Check if tooltip was previously dismissed on page load
function checkTooltipDismissed() {
    if (localStorage.getItem('refreshTooltipDismissed') === 'true') {
        tooltipDismissed = true;
        const tooltip = document.getElementById('refreshTooltip');
        if (tooltip) {
            tooltip.classList.add('dismissed');
        }
    }
}