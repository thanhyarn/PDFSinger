const crypto = require("crypto");
const bcrypt = require("bcrypt");
const Key = require("../models/key");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const SignedFile = require("../models/SignedFile");

function isValidToken(token) {
  try {
    const secretKey = req.app.get("secretKey");
    // Giải mã token
    const decoded = jwt.verify(token, secretKey);

    // Nếu giải mã thành công, token là hợp lệ
    return true;
  } catch (error) {
    // Nếu có lỗi trong quá trình giải mã (ví dụ: token hết hạn hoặc không hợp lệ), token là không hợp lệ
    return false;
  }
}

// Hàm kiểm tra dữ liệu đầu vào
function validateInput(title, encryptionType, password, confirmPassword) {
  if (!title || typeof title !== "string") {
    return "Tiêu đề không được cung cấp hoặc không hợp lệ";
  }
  if (!encryptionType || !["RSA", "DSA", "ECC"].includes(encryptionType)) {
    return "Loại mã hóa không hợp lệ";
  }
  if (!password || typeof password !== "string") {
    return "Mật khẩu không được cung cấp hoặc không hợp lệ";
  }
  if (password !== confirmPassword) {
    return "Mật khẩu và mật khẩu xác nhận không khớp";
  }
  return null; // Dữ liệu đầu vào hợp lệ
}

// Hàm tạo mới một khóa
async function createKey(req, res) {
  const token = req.headers["authorization"];

  console.log(token);
  if (!token) {
    return res.status(401).json({ error: "Token không được cung cấp" });
  }

  if (!token.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Định dạng token không hợp lệ" });
  }

  const tokenValue = token.slice(7);
  const secretKey = req.app.get("secretKey");

  try {
    const decodedToken = jwt.verify(tokenValue, secretKey);
    const userId = decodedToken.userId;

    const { title, encryptionType, password, confirmPassword } = req.body;

    console.log("encryptionType: ", encryptionType);

    console.log(req.body);
    const inputError = validateInput(
      title,
      encryptionType,
      password,
      confirmPassword
    );
    if (inputError) {
      return res.status(400).json({ error: inputError });
    }

    let privateKey;
    let publicKey;

    // Tạo cặp khóa dựa trên loại mã hóa được yêu cầu
    switch (encryptionType) {
      case "RSA": {
        const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } =
          crypto.generateKeyPairSync("rsa", {
            modulusLength: 4096,
            publicKeyEncoding: {
              type: "spki",
              format: "pem",
            },
            privateKeyEncoding: {
              type: "pkcs8",
              format: "pem",
            },
          });
        privateKey = rsaPrivateKey;
        publicKey = rsaPublicKey;
        break;
      }
      case "DSA": {
        const { privateKey: dsaPrivateKey, publicKey: dsaPublicKey } =
          crypto.generateKeyPairSync("dsa", {
            modulusLength: 2048,
            publicKeyEncoding: {
              type: "spki",
              format: "pem",
            },
            privateKeyEncoding: {
              type: "pkcs8",
              format: "pem",
            },
          });
        privateKey = dsaPrivateKey;
        publicKey = dsaPublicKey;
        break;
      }
      case "ECC": {
        const { privateKey: eccPrivateKey, publicKey: eccPublicKey } =
          crypto.generateKeyPairSync("ec", {
            namedCurve: "secp256k1",
            publicKeyEncoding: {
              type: "spki",
              format: "pem",
            },
            privateKeyEncoding: {
              type: "sec1",
              format: "pem",
            },
          });
        privateKey = eccPrivateKey;
        publicKey = eccPublicKey;
        break;
      }
      default:
        return res.status(400).json({ error: "Loại mã hóa không hợp lệ" });
    }

    // Tạo salt mới
    const salt = await bcrypt.genSalt(10); // Băm mật khẩu

    const passwordHash = await bcrypt.hash(password, 10);
    const iv = crypto.randomBytes(16);
    7;
    // console.log(privateKey);
    // Mã hóa khóa private
    const encryptedPrivateKey = encrypt(privateKey, password, salt, iv);

    // Lưu dữ liệu khóa
    const newKey = new Key({
      title,
      userId,
      encryptionType,
      password: passwordHash,
      publicKey: publicKey.toString("base64"),
      privateKey: encryptedPrivateKey,
      salt: salt, // Lưu salt vào cơ sở dữ liệu
      iv: iv.toString("base64"), // Lưu IV dưới dạng base64 để có thể lưu trữ và sử dụng sau này
    });

    await newKey.save();

    res.status(201).json({ message: "Tạo khóa thành công" });
  } catch (error) {
    console.error("Lỗi khi tạo khóa:", error);
    res.status(500).json({ message: "Không thể tạo khóa" });
  }
}
async function decryptKey(req, res) {
  const { keyId, password } = req.body;

  // Kiểm tra xác thực token và xử lý lỗi nếu cần thiết
  try {
    // Lấy thông tin khóa từ cơ sở dữ liệu dựa trên id_key
    const key = await Key.findById(keyId);

    if (!key) {
      return res.status(404).json({ error: "Không tìm thấy khóa" });
    }

    // So sánh mật khẩu đã cung cấp với mật khẩu đã băm trong cơ sở dữ liệu
    const isPasswordCorrect = await bcrypt.compare(password, key.password);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: "Mật khẩu không đúng" });
    }

    // Giải mã private key
    const decryptedPrivateKey = decrypt(
      key.privateKey,
      password,
      key.salt,
      key.iv
    );

    res.status(200).json({ decryptedPrivateKey });
  } catch (error) {
    console.error("Lỗi khi giải mã khóa:", error);
    res.status(500).json({ error: "Không thể giải mã khóa" });
  }
}

function decrypt(data, password, saltBase64, ivBase64) {
  const salt = Buffer.from(saltBase64, "base64");
  const iv = Buffer.from(ivBase64, "base64");
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(data, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function encrypt(privateKey, password, saltBase64, ivBase64) {
  const salt = Buffer.from(saltBase64, "base64");
  const iv = Buffer.from(ivBase64, "base64");
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(privateKey, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

async function getAllSignaturesByUserId(req, res) {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(401).json({ error: "Token không được cung cấp" });
  }

  if (!token.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Định dạng token không hợp lệ" });
  }

  const tokenValue = token.slice(7);
  const secretKey = req.app.get("secretKey");

  try {
    const decodedToken = jwt.verify(tokenValue, secretKey);
    const userId = decodedToken.userId;

    // Find all signatures created by the user
    const signatures = await Key.find({ userId: userId });

    // Map each signature to an object containing more information
    const signatureObjects = signatures.map((signature) => ({
      signatureId: signature._id, // Assuming the signature id is stored in _id field
      signatureNames: signature.title,
      encryptionType: signature.encryptionType, // Assuming encryptionType is a field in the signature document
      created_at: signature.created_at, // Assuming created_at is a field in the signature document
      status: signature.status, // Assuming status is a field in the signature document
    }));

    // Respond with the list of signature objects
    res.status(200).json({ signatures: signatureObjects });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách chữ ký:", error);
    res.status(500).json({ message: "Không thể lấy danh sách chữ ký" });
  }
}

async function deleteKey(req, res) {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(401).json({ error: "Token không được cung cấp" });
  }

  if (!token.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Định dạng token không hợp lệ" });
  }
  const tokenValue = token.slice(7);
  const secretKey = req.app.get("secretKey");
  try {
    const decodedToken = jwt.verify(tokenValue, secretKey);
    const userId = decodedToken.userId;

    // Find all signatures created by the user
    const signatures = await Key.find({ userId: userId });

    // Xác định _id của dữ liệu cần xóa từ req.body
    const record = req.body.record;
    if (!record) {
      // Check if _id exists
      return res.status(400).json({ error: "Thiếu thông tin record hoặc _id" });
    }
    // Kiểm tra xem _id có hợp lệ hay không
    console.log(signatures);
    console.log(record);
    const isValidId = signatures.some(
      (signature) => signature._id == record.toString()
    ); // Compare with _id as a string
    if (!isValidId) {
      return res
        .status(400)
        .json({ error: "Không tìm thấy dữ liệu với _id đã cung cấp" });
    }
    // Xóa dữ liệu có _id tương ứng
    await Key.deleteOne({ _id: record });

    res.status(200).json({ message: "Xóa dữ liệu thành công" });
  } catch (error) {
    console.error("Lỗi ", error);
    res.status(500).json({ message: "Err" });
  }
}

async function changeStatus(req, res) {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(401).json({ error: "Token không được cung cấp" });
  }

  if (!token.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Định dạng token không hợp lệ" });
  }
  const tokenValue = token.slice(7);
  const secretKey = req.app.get("secretKey");
  try {
    const decodedToken = jwt.verify(tokenValue, secretKey);
    const userId = decodedToken.userId;

    // Kiểm tra xem có record cần thay đổi không
    const recordId = req.body.record;
    if (!recordId) {
      return res.status(400).json({ error: "Thiếu thông tin record hoặc _id" });
    }

    // Tìm record cần thay đổi trạng thái
    const existingRecord = await Key.findById(recordId);

    if (!existingRecord) {
      return res
        .status(404)
        .json({ error: "Không tìm thấy dữ liệu với _id đã cung cấp" });
    }

    // Thay đổi trạng thái của record
    existingRecord.status =
      existingRecord.status === "active" ? "inactive" : "active";
    await existingRecord.save();

    res.status(200).json({
      message: "Thay đổi trạng thái thành công",
      record: existingRecord,
    });
  } catch (error) {
    console.error("Lỗi ", error);
    res
      .status(500)
      .json({ message: "Lỗi trong quá trình thay đổi trạng thái" });
  }
}

async function editTitle(req, res) {
  const token = req.headers["authorization"];
  if (!token) {
    return res.status(401).json({ error: "Token không được cung cấp" });
  }

  if (!token.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Định dạng token không hợp lệ" });
  }
  const tokenValue = token.slice(7);
  const secretKey = req.app.get("secretKey");
  try {
    const decodedToken = jwt.verify(tokenValue, secretKey);
    const userId = decodedToken.userId;

    // Kiểm tra xem có record cần thay đổi không
    const { record, newTitle } = req.body;
    if (!record) {
      return res.status(400).json({ error: "Thiếu thông tin record hoặc _id" });
    }

    // Tìm record cần chỉnh sửa tiêu đề
    const existingRecord = await Key.findById(record);

    if (!existingRecord) {
      return res
        .status(404)
        .json({ error: "Không tìm thấy dữ liệu với _id đã cung cấp" });
    }

    // Thay đổi tiêu đề của record
    existingRecord.title = newTitle;
    await existingRecord.save();

    res.status(200).json({
      message: "Thay đổi tiêu đề thành công",
      record: existingRecord,
    });
  } catch (error) {
    console.error("Lỗi ", error);
    res.status(500).json({ message: "Lỗi trong quá trình thay đổi tiêu đề" });
  }
}

module.exports = {
  createKey,
  decryptKey,
  getAllSignaturesByUserId,
  deleteKey,
  changeStatus,
  editTitle,
};
