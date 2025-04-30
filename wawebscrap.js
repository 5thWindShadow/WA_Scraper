const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { MongoClient } = require('mongodb');

// --- Konfigurasi MongoDB ---
const MONGO_URI = "mongodb://localhost:27017"; // Ganti jika perlu
const DB_NAME = "whatsapp_chats";
const COLLECTION_NAME = "messages";

// --- Konfigurasi Klien WhatsApp ---
const client = new Client({
    authStrategy: new LocalAuth(),
    // Opsi puppeteer (sesuaikan jika perlu, misal path ke Chrome)
    puppeteer: {
        // headless: false, // Set ke false jika ingin melihat browser saat debugging
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // Mungkin perlu user-agent custom jika ada masalah deteksi
          // '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        ],
    }
});

// --- Koneksi MongoDB ---
let db;
let messagesCollection;

async function connectMongo() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        messagesCollection = db.collection(COLLECTION_NAME);
        console.log("Berhasil terhubung ke MongoDB!");

        // BUAT INDEX UNIK: Penting untuk mencegah duplikasi saat scraping
        // Kita anggap kombinasi ID chat dan ID pesan unik
        await messagesCollection.createIndex({ chatId: 1, msgId: 1 }, { unique: true });
        // Index lain untuk query (opsional)
        await messagesCollection.createIndex({ timestamp: 1 });
        await messagesCollection.createIndex({ senderId: 1 });

    } catch (error) {
        console.error("Gagal terhubung ke MongoDB:", error);
        process.exit(1);
    }
}

// --- FUNGSI UNTUK MEMPROSES DAN MENYIMPAN PESAN (REUSABLE) ---
async function processAndSaveMessage(msg, chat, contact) {
    try {
        // Ambil info chat dan kontak jika belum ada
        if (!chat) chat = await msg.getChat();
        if (!contact) contact = await msg.getContact();

        const messageData = {
            msgId: msg.id._serialized, // ID unik pesan
            chatId: chat.id._serialized, // ID unik chat
            chatName: chat.name || (await client.getChatById(chat.id._serialized)).name, // Nama chat/grup (ambil ulang jika perlu)
            senderId: msg.from, // ID pengirim (bisa berupa chat ID jika dari Anda)
            senderName: contact.pushname || contact.name || msg.from, // Nama pengirim
            senderNumber: contact.number || (await client.getContactById(msg.from))?.number, // Nomor pengirim (ambil ulang jika perlu)
            isFromMe: msg.fromMe, // Apakah pesan dari Anda?
            timestamp: msg.timestamp, // Timestamp Unix
            processedAt: new Date(), // Kapan diproses oleh skrip
            body: msg.body, // Isi teks pesan
            type: msg.type, // Tipe pesan (chat, image, video, etc.)
            isGroupMsg: chat.isGroup,
            hasMedia: msg.hasMedia,
            quotedMsgId: msg.hasQuotedMsg ? msg.quotedMsgId?._serialized : null,
            // Tambahkan field lain jika perlu
             _raw: msg.rawData // Simpan data mentah jika ingin eksplorasi nanti (opsional, bisa besar)
        };

        // Gunakan updateOne dengan upsert untuk menyimpan atau mengabaikan jika sudah ada
        // Filter berdasarkan index unik (chatId, msgId)
        await messagesCollection.updateOne(
            { chatId: messageData.chatId, msgId: messageData.msgId },
            { $setOnInsert: messageData }, // Hanya set data jika document baru dibuat (di-insert)
            { upsert: true } // Jika tidak ada doc yg cocok filter, buat baru (insert)
        );

        // Beri log (mungkin perlu dibedakan antara pesan baru dan pesan lama yg discrape)
        console.log(`Pesan diproses: [${new Date(messageData.timestamp * 1000).toLocaleString()}] ${messageData.senderName}: ${messageData.body.substring(0, 50)}... (Chat: ${messageData.chatName})`);
        return true;

    } catch (error) {
         if (error.code === 11000) {
             // Error duplikat, ini diharapkan saat scraping pesan yang sudah ada
             console.log(`Pesan ${msg.id._serialized} sudah ada di DB.`);
         } else {
            console.error(`Error memproses/menyimpan pesan ${msg.id._serialized}:`, error);
         }
        return false;
    }
}


// --- FUNGSI SCRAPING RIWAYAT ---
async function scrapeChatHistory(targetChatName, limit = 100) { // Default limit 100 pesan
    console.warn(`\n--- MEMULAI SCRAPING UNTUK CHAT: "${targetChatName}" (Limit: ${limit}) ---`);
    console.warn("PERINGATAN: RISIKO BLOKIR AKUN SANGAT TINGGI!");

    let scrapedCount = 0;
    let successCount = 0;
    try {
        const chats = await client.getChats();
        const targetChat = chats.find(chat => chat.name === targetChatName);

        if (!targetChat) {
            console.error(`Error: Chat dengan nama "${targetChatName}" tidak ditemukan.`);
            return;
        }

        console.log(`Menemukan chat "${targetChatName}" (ID: ${targetChat.id._serialized}). Mengambil ${limit} pesan terakhir...`);

        // Ambil pesan lama
        // Hati-hati: fetchMessages bisa memakan waktu & resource
        const messages = await targetChat.fetchMessages({ limit: limit });

        console.log(`Berhasil mengambil ${messages.length} pesan dari WhatsApp.`);
        console.log("Memproses dan menyimpan ke database...");

        if (messages.length === 0) {
            console.log("Tidak ada pesan lama untuk diproses.");
            return;
        }

        // Proses setiap pesan yang diambil
        for (const msg of messages) {
            scrapedCount++;
            const contact = await msg.getContact(); // Perlu info kontak untuk nama pengirim
            const saved = await processAndSaveMessage(msg, targetChat, contact);
            if (saved) successCount++;

            // **OPSIONAL TAPI DIREKOMENDASIKAN:** Tambahkan jeda kecil antar proses pesan
            // Untuk mengurangi beban dan potensi deteksi
            await new Promise(resolve => setTimeout(resolve, 50)); // Jeda 50ms
        }

        console.log(`--- SELESAI SCRAPING untuk "${targetChatName}" ---`);
        console.log(`Total pesan diambil dari WA: ${messages.length}`);
        console.log(`Total pesan berhasil diproses/disimpan (termasuk yg sudah ada): ${successCount}/${scrapedCount}`);


    } catch (error) {
        console.error(`Error besar saat scraping chat "${targetChatName}":`, error);
        if (error.message && error.message.includes('Evaluation failed')) {
            console.error("--> Kemungkinan error ini terjadi karena struktur WhatsApp Web berubah atau ada masalah dengan Puppeteer/Browser.");
        }
    } finally {
         console.log("-----------------------------------------------\n");
    }
}


// --- Event Listeners WhatsApp ---

client.on('qr', (qr) => {
    console.log('Pindai QR Code ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', (session) => {
    console.log('Otentikasi berhasil!');
});

client.on('auth_failure', msg => {
    console.error('Kegagalan Otentikasi:', msg);
    console.error("--> Coba hapus folder .wwebjs_auth jika masalah berlanjut.");
});

client.on('ready', async () => {
    console.log('Klien WhatsApp siap!');
    console.log('Mulai mendengarkan pesan baru...');

    // --- PANGGIL FUNGSI SCRAPING DI SINI ---
    // Ganti "Nama Kontak atau Grup Target" dengan nama yang benar
    // Ganti angka 100 jika ingin mengambil lebih banyak/sedikit (hati-hati!)
    await scrapeChatHistory("tes", 100);
    await scrapeChatHistory("Happy Family", 50); // Bisa panggil beberapa kali

    // Anda mungkin ingin menunda scraping beberapa detik setelah ready
    // setTimeout(() => {
    //     scrapeChatHistory("Nama Kontak atau Grup Target", 200);
    // }, 5000); // Tunggu 5 detik setelah ready
});

client.on('message', async (msg) => {
    // Gunakan fungsi yang sama untuk memproses pesan baru
    console.log("Pesan BARU diterima, memproses..."); // Log pembeda
    await processAndSaveMessage(msg, null, null); // Kirim null agar fungsi mengambil chat/kontak sendiri
});

client.on('message_create', async (msg) => {
    // Event ini sering ter-trigger untuk pesan dari ANDA SENDIRI
    // Biasanya ter-cover oleh 'message', tapi bisa ditangani di sini jika perlu
    if (msg.fromMe) {
        console.log("Pesan KELUAR (dari Anda) terdeteksi...");
        await processAndSaveMessage(msg, null, null);
    }
});


client.on('disconnected', (reason) => {
    console.log('Klien terputus:', reason);
    // Coba reinitialize jika perlu (hati-hati loop tak terbatas)
    client.initialize();
});

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});


// --- Inisialisasi Utama ---
async function main() {
    await connectMongo(); // Hubungkan ke DB dulu
    client.initialize(); // Mulai klien WhatsApp
}

main();