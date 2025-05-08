const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { MongoClient, ObjectId } = require('mongodb');

// --- Konfigurasi MongoDB ---
const MONGO_URI = "mongodb://localhost:27017"; // Ganti jika perlu
const DB_NAME = "whatsapp_chats";
const MESSAGES_COLLECTION_NAME = "messages";
const GROUP_INVITES_COLLECTION_NAME = "group_invites";

// --- Konfigurasi Klien WhatsApp ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        // headless: false, // Uncomment untuk melihat browser saat debugging
    }
});

// --- Koneksi MongoDB ---
let db;
let messagesCollection;
let groupInvitesCollection;

async function connectMongo() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        messagesCollection = db.collection(MESSAGES_COLLECTION_NAME);
        groupInvitesCollection = db.collection(GROUP_INVITES_COLLECTION_NAME);
        console.log("Berhasil terhubung ke MongoDB!");

        await messagesCollection.createIndex({ chatId: 1, msgId: 1 }, { unique: true });
        await messagesCollection.createIndex({ timestamp: 1 });
        await groupInvitesCollection.createIndex({ inviteLink: 1 }, { unique: true });
        await groupInvitesCollection.createIndex({ status: 1 });

    } catch (error) {
        console.error("Gagal terhubung ke MongoDB:", error);
        process.exit(1);
    }
}

// --- FUNGSI UNTUK MEMPROSES DAN MENYIMPAN PESAN ---
async function processAndSaveMessage(msg) {
    try {
        const chat = await msg.getChat();
        const contact = await msg.getContact();

        const messageData = {
            msgId: msg.id._serialized,
            chatId: chat.id._serialized,
            chatName: chat.name,
            senderId: msg.from,
            senderName: contact.pushname || contact.name || msg.from,
            senderNumber: contact.number,
            isFromMe: msg.fromMe,
            timestamp: msg.timestamp,
            processedAt: new Date(),
            body: msg.body,
            type: msg.type,
            isGroupMsg: chat.isGroup,
            hasMedia: msg.hasMedia,
            quotedMsgId: msg.hasQuotedMsg ? msg.quotedMsgId?._serialized : null,
        };

        const result = await messagesCollection.updateOne(
            { chatId: messageData.chatId, msgId: messageData.msgId },
            { $setOnInsert: messageData },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            console.log(`PESAN BARU DISIMPAN: [${new Date(messageData.timestamp * 1000).toLocaleTimeString()}] ${messageData.senderName} (di ${messageData.chatName}): ${messageData.body.substring(0, 30)}...`);
        }

    } catch (error) {
        if (error.code !== 11000) {
            console.error(`Error memproses/menyimpan pesan ${msg.id._serialized}:`, error);
        }
    }
}

// --- FUNGSI UNTUK MENCOBA JOIN GRUP ---
async function attemptToJoinGroup(inviteLinkDocument) {
    const inviteCode = inviteLinkDocument.inviteLink.replace("https://chat.whatsapp.com/", "").trim();
    console.log(`[JOIN GRUP] Mencoba bergabung ke grup dengan kode: ${inviteCode} (Link: ${inviteLinkDocument.inviteLink})`);

    try {
        const groupChatId = await client.acceptInvite(inviteCode);
        console.log(`[JOIN GRUP] BERHASIL bergabung! ID Grup: ${groupChatId}. Link: ${inviteLinkDocument.inviteLink}`);

        await groupInvitesCollection.updateOne(
            { _id: inviteLinkDocument._id },
            { $set: { status: "joined", lastAttempt: new Date(), errorMessage: null } }
        );
        return true;
    } catch (error) {
        console.error(`[JOIN GRUP] GAGAL bergabung ${inviteCode} (Link: ${inviteLinkDocument.inviteLink}):`, error.message);
        let status = "failed";
        const errMsg = error.message.toLowerCase();

        if (errMsg.includes("invite_link_expired") || errMsg.includes("invalid") || errMsg.includes("not a valid invite code") || errMsg.includes("no longer valid")) {
            status = "invalid_link";
        } else if (errMsg.includes("already in group") || errMsg.includes("is already a participant")) {
            status = "joined"; // Tandai sudah join jika errornya karena sudah ada di grup
        } else if (errMsg.includes("group is full")) {
            status = "group_full";
        }


        await groupInvitesCollection.updateOne(
            { _id: inviteLinkDocument._id },
            { $set: { status: status, lastAttempt: new Date(), errorMessage: error.message } }
        );
        return false;
    }
}

// --- FUNGSI UNTUK MEMPROSES SATU LINK GRUP DARI DB (OPSI A) ---
let isProcessingSingleInvite = false; // Flag untuk mencegah tumpang tindih

async function processSingleGroupInvite() {
    if (isProcessingSingleInvite) {
        // console.log("[JOIN GRUP] Masih dalam proses join sebelumnya, skip iterasi ini.");
        return;
    }
    if (!client.info || !client.pupPage) { // Pastikan klien dan halaman puppeteer siap
        console.log("[JOIN GRUP] Klien belum sepenuhnya siap, tunda proses join grup.");
        return;
    }

    isProcessingSingleInvite = true;
    // console.log("[JOIN GRUP] Memeriksa database untuk satu link grup 'pending'...");

    try {
        const inviteDoc = await groupInvitesCollection.findOne({ status: "pending" });

        if (!inviteDoc) {
            // console.log("[JOIN GRUP] Tidak ada link grup 'pending' yang ditemukan saat ini.");
            isProcessingSingleInvite = false;
            return;
        }

        console.log(`[JOIN GRUP] Menemukan link 'pending': ${inviteDoc.inviteLink}. Memproses...`);
        await attemptToJoinGroup(inviteDoc);

        // Tambahkan jeda signifikan SEBELUM memproses link berikutnya (diatur oleh interval utama)
        // Jeda kecil di sini opsional jika dirasa perlu setelah satu percobaan join
        // await new Promise(resolve => setTimeout(resolve, 2000)); // Jeda 2 detik setelah satu attempt

    } catch (error) {
        console.error("[JOIN GRUP] Error saat mengambil atau memproses satu link grup dari DB:", error);
    } finally {
        isProcessingSingleInvite = false; // Lepas flag setelah selesai atau error
    }
}

// --- Event Listeners WhatsApp ---

client.on('qr', (qr) => {
    console.log('Pindai QR Code ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', (session) => {
    console.log('Otentikasi berhasil!');
    // Sesi bisa disimpan jika tidak menggunakan LocalAuth, tapi LocalAuth lebih direkomendasikan
});

client.on('auth_failure', msg => {
    console.error('Kegagalan Otentikasi:', msg);
    console.error("--> Jika masalah berlanjut, coba hapus folder .wwebjs_auth dan scan ulang.");
});

client.on('ready', async () => {
    console.log('Klien WhatsApp SIAP!');
    console.log(`Terhubung sebagai: ${client.info.pushname || 'Tidak diketahui'} (${client.info.wid.user})`);
    console.log('Mulai mendengarkan pesan baru...');

    // Jalankan proses join grup pertama kali setelah beberapa detik klien siap
    // Memberi waktu WA Web untuk stabil sepenuhnya
    setTimeout(async () => {
        console.log("[JOIN GRUP] Memulai pemeriksaan pertama untuk link grup 'pending'...");
        await processSingleGroupInvite();
    }, 15000); // Tunggu 15 detik setelah ready

    // Set interval untuk memeriksa link grup baru secara periodik
    // Setiap pemanggilan akan mencoba memproses SATU link 'pending'.
    // Interval 1-2 menit mungkin cukup. Jangan terlalu sering!
    const groupCheckInterval = 2 * 60 * 1000; // 2 menit
    setInterval(processSingleGroupInvite, groupCheckInterval);
    console.log(`[JOIN GRUP] Pemeriksaan periodik (setiap ${groupCheckInterval / 1000 / 60} menit) untuk link grup baru telah dijadwalkan.`);
});

client.on('message', async (msg) => {
    // console.log(`DEBUG: Event 'message' diterima - ID: ${msg.id._serialized}`);
    await processAndSaveMessage(msg);
});

client.on('message_create', async (msg) => {
    // Event ini untuk pesan yang dikirim oleh akun ini
    if (msg.fromMe) {
        // console.log(`DEBUG: Event 'message_create' (fromMe) diterima - ID: ${msg.id._serialized}`);
        await processAndSaveMessage(msg);
    }
});

client.on('group_join', async (notification) => {
    try {
        console.log('[NOTIFIKASI] Akun ini BERGABUNG ke grup:');
        const chat = await client.getChatById(notification.chatId._serialized);
        console.log(`  -> Nama Grup: ${chat.name}`);
        console.log(`  -> ID Grup: ${chat.id._serialized}`);
        // Opsional: Update status di DB jika relevan
        const inviteLinkDoc = await groupInvitesCollection.findOne({ inviteLink: { $regex: chat.id.user } }); // Mencoba mencocokkan ID grup dengan link
        if (inviteLinkDoc && inviteLinkDoc.status !== "joined") {
            await groupInvitesCollection.updateOne({ _id: inviteLinkDoc._id }, { $set: { status: "joined", errorMessage: "Joined via group_join event" }});
            console.log(`  -> Status link grup terkait di DB diupdate ke 'joined'.`);
        }
    } catch (error) {
        console.error("[NOTIFIKASI] Error memproses event group_join:", error);
    }
});

client.on('group_leave', async (notification) => {
    try {
        console.log('[NOTIFIKASI] Akun ini KELUAR/DIKELUARKAN dari grup:');
        const chat = await client.getChatById(notification.chatId._serialized);
        console.log(`  -> Nama Grup: ${chat.name}`);
        console.log(`  -> ID Grup: ${chat.id._serialized}`);
        // Opsional: Update status di DB
    } catch (error) {
        console.error("[NOTIFIKASI] Error memproses event group_leave:", error);
    }
});

client.on('disconnected', (reason) => {
    console.error('Klien terputus:', reason);
    // Pertimbangkan strategi re-koneksi otomatis jika diperlukan, tapi hati-hati dengan loop
    // client.initialize(); // Ini bisa menyebabkan loop jika ada masalah persisten
});

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

// --- Inisialisasi Utama ---
async function main() {
    await connectMongo();
    console.log("Memulai inisialisasi klien WhatsApp...");
    client.initialize();
}

main().catch(err => {
    console.error("Error fatal di fungsi main:", err);
    process.exit(1);
});