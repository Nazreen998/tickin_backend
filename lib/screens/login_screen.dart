import 'package:flutter/material.dart';
import '../api/auth_api.dart';
import '../storage/token_store.dart';
import 'home_screen.dart';

class LoginScreen extends StatefulWidget {
  final AuthApi authApi;
  final TokenStore tokenStore;
  const LoginScreen({super.key, required this.authApi, required this.tokenStore});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final mobileCtrl = TextEditingController();
  final passCtrl = TextEditingController();
  bool loading = false;

  void toast(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  Future<void> doLogin() async {
    setState(() => loading = true);
    try {
      final res = await widget.authApi.login(
  mobile: mobileCtrl.text.trim(),
  password: passCtrl.text.trim(),
);

await widget.tokenStore.saveToken(res["token"].toString());
await widget.tokenStore.saveUserJson(AuthApi.userToJson(res));

      if (!mounted) return;
      Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => const HomeScreen()));
    } catch (e) {
      toast(e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Tickin Login")),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(controller: mobileCtrl, decoration: const InputDecoration(labelText: "Mobile")),
            TextField(controller: passCtrl, decoration: const InputDecoration(labelText: "Password"), obscureText: true),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: loading ? null : doLogin,
              child: loading
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text("Login"),
            ),
            const SizedBox(height: 8),
            const Text("Note: If login path differs, change ApiConfig.loginPath"),
          ],
        ),
      ),
    );
  }
}
