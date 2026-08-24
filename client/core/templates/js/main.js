const answeredColor = '#606060';
let socket = null;
let disconnectCountdownIntervalId = null;

// QR code join: track the game ID from the ?game= query parameter
let qrJoinGameId = null;
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
        buttonBid: document.getElementById('button_bid'),
        buttonPass: document.getElementById('button_pass'),
        youAreHighestBidder: document.getElementById('you_are_highest_bidder'),
        notEnoughPoints: document.getElementById('not_enough_points'),
        passing: document.getElementById('passing'),

        enableControls() {
            this.yourBid.disabled = false;
            this.buttonBid.disabled = false;
            this.buttonPass.disabled = false;
        },

        disableControls() {
            this.yourBid.disabled = true;
            this.buttonBid.disabled = true;
            this.buttonPass.disabled = true;
        },

        onBidClicked(auction) {
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
            this.yourBid.min = auction.highestBid + 1;
            this.yourBid.max = yourScore;
            this.yourBid.value = auction.highestBid + 1;
            this.yourBid.hidden = !auction.canBid;
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

        // Base the list on the team roster minus the captain, so every teammate shows up
        // immediately (spinner) even before anyone has submitted. Submitted values overlay on top.
        var captainId = window.myTeam.CaptainId;
        var members = (window.myTeam.Members || []).filter(function (m) { return m.Id !== captainId; });
        if (members.length === 0) { strip.hidden = true; return; }

        var submittedById = {};
        (window.teamSuggestions || []).forEach(function (it) {
            if (it && it.Status === 'submitted') submittedById[it.Id] = (it.Value != null ? it.Value : '');
        });

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
        if (group && group.children[idx]) group.children[idx].style.background = answeredColor;
    }

    // Persistent role badge shown on every screen in team mode: captain or member + team name.
    function updateCaptainBadge() {
        var badge = document.getElementById('captain_badge');
        if (!badge) return;
        if (!window.teamMode || !window.myTeam) { badge.hidden = true; return; }

        var text = document.getElementById('captain_badge_text');
        if (text) {
            var key = window.amCaptain ? 'you_are_captain' : 'you_are_member';
            var word = t(key);
            if (word === key) word = window.amCaptain ? 'Captain' : 'Member'; // locale missing key → English
            var icon = window.amCaptain ? '👑' : '👤';
            var teamName = (window.myTeam && window.myTeam.Name) ? window.myTeam.Name : '';
            text.textContent = icon + ' ' + [word, teamName].filter(Boolean).join(' · ');
        }
        badge.hidden = false;
    }
    window.updateCaptainBadge = updateCaptainBadge;

    function hideSuggStrip() {
        var s = document.getElementById('sugg_strip');
        if (s) s.hidden = true;
    }
    window.hideSuggStrip = hideSuggStrip;

    function resetTeamSuggestions() {
        window.teamSuggestions = [];
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
                btn.className = 'button color-green join-btn';
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
        TEAMMATE_READONLY: {
            title: (d) => (d && d.cantAnswer) ? t('you_cant_answer_now') : t('captain_decides_short'),
            show: ['teammate_readonly_group'],
            onEnter: (d) => {
                var note = document.getElementById('teammate_readonly_note');
                if (note) note.textContent = (d && d.cantAnswer) ? t('you_cant_answer_now') : t('captain_decides');
            }
        },
        TEAMMATE_SUGGEST: {
            title: () => t('captain_decides_short'),
            show: ['teammate_suggest_group'],
            onEnter: (d) => {
                // Buzz mode (button not pressed yet): only the buzzer — no suggestion field, no list.
                // Suggest mode (team already buzzed in): suggestion field + list, no buzzer.
                var buzzMode = !!(d && d.showBuzzer);
                var buzz = document.getElementById('teammate_buzzer');
                if (buzz) buzz.hidden = !buzzMode;
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
            onEnter: (d) => { if (d && d.themes) CreateQuestionsFromJson(d.themes); }
        },
        SELECT_QUESTION_PLAYER: {
            title: (d) => d.selector + ' ' + t('selects_the_question'),
            show: ['select_question_player_group']
        },
        QUESTION_SELECTED: {
            show: ['question_selected_group'],
            onEnter: (d) => {
                if (window.pqStore.getItem('role') === 'host')
                    document.getElementById('right_answer_group').hidden = false;
                if (d) {
                    if (d.Theme) document.getElementById('question_selected_theme').textContent = d.Theme;
                    if (d.Price) document.getElementById('question_selected_price').textContent = d.Price;
                }
            }
        },
        GET_READY: {
            title: () => t('READY...STEADY...'),
            show: ['get_ready_player_group']
        },
        CAN_ANSWER: {
            show: ['can_answer_player_group'],
            onEnter: (d) => {
                if (d && (d.triedToAnswer || d.wasCorrect)) {
                    document.getElementById('title').textContent = t("you_cant_answer_now");
                    document.getElementById('answer_button').hidden = true;
                    hideSuggStrip();
                } else {
                    document.getElementById('title').textContent = t('' +
                        '');
                    document.getElementById('answer_button').hidden = false;
                    renderSuggestions();
                }
            }
        },
        PLAYER_ANSWERS_HOST: {
            title: '',
            show: ['player_answers_host_group', 'right_answer_group'],
            onEnter: (d) => {
                document.getElementById('answering_player').textContent = d.player;
                
                if (d.answer)
                    document.getElementById('right_answer').textContent = d.answer;
            }
        },
        YOU_ANSWER: {
            title: () => t('YOU ANSWER!'),
            show: ['you_answer_group'],
            onEnter: () => { renderSuggestions(); }
        },
        ALL_QUESTIONS_ANSWERED_HOST: {
            show: ['all_questions_answered_host_group']
        },
        ALL_QUESTIONS_ANSWERED_PLAYER: {
            show: ['all_questions_answered_player_group']
        },
        CAT_IN_POKE_HOST: {
            title: () => t('WHO GETS THE CAT?'),
            undertitle: (d) => t('THEME:') + ' ' + d.Theme + ', ' + t('PRICE:') + ' ' + d.Price,
            show: ['cat_in_poke_host_group'],
            onEnter: (d) => CreatePlayersForCatInPoke(d.Players)
        },
        CAT_IN_POKE_PLAYER: {
            title: () => t('CAT IN A POKE SELECTION'),
            undertitle: (d) => t('THEME:') + ' ' + d.Theme + ', ' + t('PRICE:') + ' ' + d.Price,
            show: ['cat_in_poke_player_group'],
            onEnter: () => ClearCatInPokeTable()
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
            title: () => t('LOOK AT THE SCREEN')
        },
        SEQUENCE_HOST: {
            title: () => t('LOOK AT THE SCREEN'),
            show: ['skip_displaying_group']
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
        DISPLAY_FINAL_RESULT: {
            title: () => t('THE GAME HAS COME TO AN END'),
            undertitle: (d) => t('YOUR SCORE:') + ' ' + d.score
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
            undertitle: (d) => t('THEME:') + ' ' + d.theme,
            show: ['auction_host_group'],
            onEnter: () => window.auctionHostPage.enableControls()
        },
        AUCTION_PLAYER: {
            title: () => t('AUCTION'),
            undertitle: (d) => t('THEME:') + ' ' + d.Theme,
            show: ['auction_player_group'],
            onEnter: (d) => UpdateAuctionPlayerPage(d.BidderId, d.BidderName, d.Bid, d.YourScore, d.YouPass, d.YourTurn)
        },
        MULTIPLE_CHOICE_HOST: {
            title: () => t('VOTING IN PROGRESS'),
            show: ['multiple_choice_host_group']
        },
        MULTIPLE_CHOICE_PLAYER: {
            title: (d) => d && d.question ? d.question : '',
            show: ['multiple_choice_options_group'],
            onEnter: (d) => {
                window._mcOptions = (d && d.options) || [];
                window._mcVoted = false;
                CreateMultipleChoiceOptions(d.options);
                renderSuggestions();
            }
        },
        VOTE_ACCEPTED: {
            title: () => t('YOUR VOTE HAS BEEN ACCEPTED')
        },
        NUMBER_GUESS_HOST: {
            title: () => t('GUESSING IN PROGRESS'),
            show: ['number_guess_host_group']
        },
        NUMBER_GUESS_PLAYER: {
            title: () => t('GUESS THE NUMBER'),
            show: ['number_guess_player_group'],
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
            title: () => t('YOUR GUESS HAS BEEN ACCEPTED')
        },
        DECIDE_FINAL_PLAYERS: {
            show: ['decide_final_players_group']
        },
        REVEALING_CLUES_HOST: {
            show: ['stop_guessing_or_end_question_group']
        },
        REVEALING_CLUES_PLAYER: {
            title: (d) => d && d.clue ? d.clue : '',
            show: ['guess_or_pass_player_group'],
            onEnter: () => { renderSuggestions(); }
        },
        REVEALING_CLUES_DECIDE: {
            title: () => t('WAS THE ANSWER CORRECT?'),
            show: ['revealing_clues_decide_answer_group'],
            onEnter: (d) => {
                document.getElementById('revealing_clues_answering_player').textContent = d.player;
                document.getElementById('revealing_clues_player_answer').textContent = d.playerAnswer;
                document.getElementById('revealing_clues_right_answer').textContent = d.rightAnswer;
            }
        },
        REVEALING_CLUES_CHOICE_MADE: {
            title: () => t('YOUR VOTE HAS BEEN ACCEPTED')
        },
        APPLAUSE: {
            title: () => t('clap_title'),
            undertitle: () => t('game_over_clap'),
            show: ['applause_group']
        }
    };

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

        var prev = currentState;
        currentState = stateName;
        console.log('Page: ' + (prev || '(init)') + ' → ' + stateName);
        botReport('Page: ' + (prev || '(init)') + ' -> ' + stateName);

        updateCaptainBadge();

        maybeBotAutoAdvance(stateName);
    }

    window.goTo = goTo;

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
        connecting = true;

        let serverOverride = getQueryParam('server');
        let host = serverOverride || window.location.hostname;

        if (!serverOverride && host == 'localhost')
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
        // CONN-03: Clear stale state from previous session before re-registering
        resetGameState();

        // CONN-07: Clear disconnect toast and countdown
        if (disconnectCountdownIntervalId) {
            clearInterval(disconnectCountdownIntervalId);
            disconnectCountdownIntervalId = null;
        }
        var reconnectionScreen = document.getElementById('reconnection_screen');
        if (reconnectionScreen) reconnectionScreen.hidden = true;

        updateRefreshButtonVisibility(true);

        connecting = false;
        reconnectAttempt = 0;
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
            if (qrJoinGameId) {
                console.log("QR join: auto-joining game " + qrJoinGameId);
                TryJoinGameWithId(qrJoinGameId, '');
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
                qrJoinGameId = null;
                qrJoinAwaitingPassword = false;
                goTo('ENTER_ID');
                var mmKey = 'mm_' + response.MatchMakerError.text.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                var localized = t(mmKey);
                reportError(localized !== mmKey ? localized : response.MatchMakerError.text);
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
                        goTo('RESUME_GAME');
                    }
                } else {
                    if (qrJoinGameId) {
                        console.log("QR join: session clear, auto-joining game " + qrJoinGameId);
                        TryJoinGameWithId(qrJoinGameId, '');
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
                        document.getElementById('select_question_player_group_score').textContent = message.Score;
                    } else if (command == "StartGame") {
                        // A new game clears the answering latch and sequence tracker
                        resetAnsweringTracking();

                        if (message.StartGame.AllowedToChoose) {
                            if (window.teamMode && !window.amCaptain && !isHost)
                                goTo('TEAMMATE_READONLY'); // only the captain (or the quiz host) picks the question
                            else
                                goTo('SELECT_QUESTION_HOST', { themes: message.StartGame.Themes });
                        } else {
                            window.pqStore.setItem('name', message.StartGame.Name);

                            document.getElementById('select_question_player_group_score').textContent = message.StartGame.Score;
                            document.getElementById('select_question_player_group_name').textContent = message.StartGame.Name;

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
                        if (message.StartCatInPoke.CanSelect) {
                            goTo('CAT_IN_POKE_HOST', message.StartCatInPoke);
                        } else if (window.teamMode && !window.amCaptain && !isHost) {
                            goTo('TEAMMATE_READONLY');
                        } else {
                            goTo('CAT_IN_POKE_PLAYER', message.StartCatInPoke);
                        }
                    } else if (command == "StartAuction") {
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
                        if (isPlayer)
                            goTo('DISPLAY_FINAL_RESULT', { score: message.DisplayFinalResult.Score });
                    } else if (command == "StartApplause") {
                        goTo('APPLAUSE');
                    } else if (command == "StopApplause") {
                        if (isHost)
                            goTo('SEQUENCE_HOST');
                        else if (isPlayer)
                            goTo('SEQUENCE_PLAYER');
                    } else if (command == "CameraRoster") {
                        ShowCameraButton(message.CameraRoster.Cameras)
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
                        if (isHost)
                            CreatePlayersForScoreChange(message.Players);
                    } else if (command == "AnswerRevealed") {
                        if (isHost)
                            showOverlay('skip_displaying_group');
                    } else if (command == "StartMultipleChoice") {
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
                        if (isHost)
                            goTo('REVEALING_CLUES_HOST');
                        else if (isPlayer) {
                            resetTeamSuggestions();
                            if (window.teamMode && !window.amCaptain) {
                                goTo('TEAMMATE_SUGGEST', { showBuzzer: false, label: 'your_suggestion' });
                            } else {
                                goTo('REVEALING_CLUES_PLAYER', { clue: message.RevealingCluesStarted.Clue });
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
        connecting = false;
        // CONN-06: Do NOT reset inGame/gameStarted on wasClean.
        // Matchmaker sets player.socket = None on disconnect but keeps the player in the game.
        // Resetting inGame here destroys the reconnect path.

        // CONN-01: Exponential backoff capped at 30s with jitter
        const BASE_WAIT_MS = 1000;
        const MAX_RECONNECT_WAIT_MS = 30000;
        const jitter = Math.random() * 1000;
        const waitTime = Math.min(BASE_WAIT_MS * Math.pow(2, reconnectAttempt), MAX_RECONNECT_WAIT_MS) + jitter;
        reconnectAttempt++;
        setConnectionDotState('reconnecting');

        // CONN-07: Show disconnect toast with countdown when in-game
        if (inGame) {
            showDisconnectedToast(Math.ceil(waitTime / 1000));
        }

        console.log(JSON.stringify(event) + " " + event.code);
        setTimeout(createSocket, waitTime);
    }

    function updateConnectionScreen() {
        document.getElementById('reconnection_screen').hidden = !(inGame && connecting);
    }

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
                    item.style.background = answeredColor;
                } else {
                    (function (themeId, qId, el) {
                        var unbind = null;
                        function handler() {
                            SelectQuestion(themeId, qId);
                            el.style.background = answeredColor;
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
                    el.style.background = answeredColor;
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
        if (playerId == "random") {
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
                el.style.background = answeredColor;
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
                    el.style.background = answeredColor;
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
                    el.style.background = answeredColor;
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
                    el.style.background = answeredColor;
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

    function ShowCameraButton(roster) {
        if (createdCameraButtons) return;
        createdCameraButtons = true;
        var dropdown = document.getElementsByClassName("camera_roster")[0];
        document.getElementsByClassName("camera_control")[0].style.display = 'inline-block';

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
        document.querySelector('#emoji_layer').style.display = gameStarted ? 'flex' : 'none';
    }

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

function OpenCustomAvatarModal() {
    var overlay = document.getElementById('custom_avatar_modal_overlay');
    var modal = document.getElementById('custom_avatar_modal');
    if (overlay) overlay.hidden = false;
    if (modal) {
        modal.hidden = false;
        requestAnimationFrame(function() { autoFitButtons(modal); });
    }
}

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