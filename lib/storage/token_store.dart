import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStore {
  static const _kToken = "token";
  static const _kUser = "user_json";

  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<void> saveToken(String token) async {
    await _storage.write(key: _kToken, value: token);
  }

  Future<String?> getToken() async {
    return _storage.read(key: _kToken);
  }

  Future<void> saveUserJson(String userJson) async {
    await _storage.write(key: _kUser, value: userJson);
  }

  Future<String?> getUserJson() async {
    return _storage.read(key: _kUser);
  }

  Future<void> clear() async {
    await _storage.delete(key: _kToken);
    await _storage.delete(key: _kUser);
  }
}
